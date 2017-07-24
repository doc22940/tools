/**
 * @license
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import * as dom5 from 'dom5';
import * as estree from 'estree';
import {AssignmentExpression, BlockStatement, Expression, ExpressionStatement, FunctionExpression, Identifier, ImportDeclaration, MemberExpression, ModuleDeclaration, Node, ObjectExpression, Program, Statement} from 'estree';
import * as parse5 from 'parse5';
import * as path from 'path';
import {Document, Import, Namespace, ParsedJavaScriptDocument} from 'polymer-analyzer';
import * as recast from 'recast';

import jsc = require('jscodeshift');
import {AnalysisConverter} from './analysis-converter';
import {htmlUrlToJs} from './url-converter';
import {JsModule, JsExport, NamespaceMemberToExport} from './js-module';

const astTypes = require('ast-types');
type AstPath<N extends Node> = {
  node: N,
  parent?: {node: Node}
};

/**
 * Replace a jscodeshift path node with an export identifier for the given
 * JsExport & JsModule. Nothing is returned, the path node is modified.
 */
function replacePathWithExportIdentifier(
    path: any, moduleExport: JsExport, jsModule: JsModule) {
  if (moduleExport.name === '*') {
    path.replace(jsc.identifier(getModuleId(jsModule.url)));
  } else {
    path.replace(jsc.identifier(getImportAlias(moduleExport.name)));
  }
}

/**
 * Convert a module specifier & an optional set of named exports (or '*' to
 * import entire namespace) to a set of ImportDeclaration objects.
 */
function getImportDeclarations(
    specifierUrl: string, namedExports?: Iterable<string>) {
  const jsImportDeclarations: ImportDeclaration[] = [];
  const namedExportsArray = namedExports ? Array.from(namedExports) : [];
  const hasNamespaceReference = namedExportsArray.some((s) => s === '*');
  const namedSpecifiers =
      namedExportsArray.filter((s) => s !== '*')
          .map(
              (s) => jsc.importSpecifier(
                  jsc.identifier(s), jsc.identifier(getImportAlias(s))));
  // If a module namespace was referenced, create a new namespace import
  if (hasNamespaceReference) {
    jsImportDeclarations.push(jsc.importDeclaration(
        [jsc.importNamespaceSpecifier(
            jsc.identifier(getModuleId(specifierUrl)))],
        jsc.literal(specifierUrl)));
  }
  // If any named imports were referenced, create a new import for all named
  // members. If `namedSpecifiers` is empty but a namespace wasn't imported
  // either, then still add an empty importDeclaration to trigger the load.
  if (namedSpecifiers.length > 0 || !hasNamespaceReference) {
    jsImportDeclarations.push(
        jsc.importDeclaration(namedSpecifiers, jsc.literal(specifierUrl)));
  }
  return jsImportDeclarations;
}


const elementBlacklist = new Set<string|undefined>([
  'base',
  'link',
  'meta',
  'script',
  'dom-module',
]);


/**
 * Converts a Document and its dependencies.
 */
export class DocumentConverter {
  private readonly jsUrl: string;
  private readonly analysisConverter: AnalysisConverter;
  private readonly document: Document;
  private program: Program;
  private readonly _mutableExports:
      {readonly [namespaceName: string]: ReadonlyArray<string>};

  constructor(analysisConverter: AnalysisConverter, document: Document) {
    this.analysisConverter = analysisConverter;
    this._mutableExports =
        <any>Object.assign({}, this.analysisConverter._mutableExports);
    this.document = document;
    this.jsUrl = htmlUrlToJs(document.url);
  }

  /**
   * Returns the HTML Imports of a document, except imports to documents
   * specifically excluded in the AnalysisConverter.
   *
   * Note: Imports that are not found are not returned by the analyzer.
   */
  private getHtmlImports() {
    return Array.from(this.document.getFeatures({kind: 'html-import'}))
        .filter((f: Import) => !this.analysisConverter._excludes.has(f.url));
  }

  convert(): Iterable<JsModule> {
    const scripts = this.document.getFeatures({kind: 'js-document'});
    if (scripts.size === 0) {
      this.program = jsc.program([]);
    } else if (scripts.size === 1) {
      const [script] = scripts;
      const jsDoc = script.parsedDocument as ParsedJavaScriptDocument;
      const file = recast.parse(jsDoc.contents);
      this.program = file.program;
    } else {
      // TODO(justinfagnani): better warning wording, plus actionable
      // reccomendation or decide on some default handling of multiple scripts.
      console.log('multiple scripts');
      return [];
    }
    this.convertDependencies();
    this.unwrapIIFEPeusdoModule();
    const importedReferences = this.rewriteNamespacedReferences();
    this.addJsImports(importedReferences);
    this.insertCodeToGenerateHtmlElements();
    this.inlineTemplates();

    const {localNamespaceName, namespaceName, exportMigrationRecords} =
        this.rewriteNamespaceExports();

    this.rewriteNamespaceThisReferences(namespaceName);
    this.rewriteReferencesToTheLocallyDefinedNamespace(localNamespaceName);
    this.rewriteReferencesToTheLocallyDefinedNamespace(namespaceName);
    this.rewriteExcludedReferences();

    const outputProgram = recast.print(
        this.program, {quote: 'single', wrapColumn: 80, tabWidth: 2});
    return [{
      url: this.jsUrl,
      source: outputProgram.code + '\n',
      exportedNamespaceMembers: exportMigrationRecords,
      es6Exports: new Set(exportMigrationRecords.map((r) => r.es6ExportName))
    }];
  }

  /**
   * Recreate the HTML contents from the original HTML document by adding
   * code to the top of this.program that constructs equivalent DOM and insert
   * it into `window.document`.
   */
  private insertCodeToGenerateHtmlElements() {
    const ast = this.document.parsedDocument.ast as parse5.ASTNode;
    if (ast.childNodes === undefined) {
      return;
    }
    const htmlElement = ast.childNodes!.find((n) => n.tagName === 'html');
    const head = htmlElement!.childNodes!.find((n) => n.tagName === 'head')!;
    const body = htmlElement!.childNodes!.find((n) => n.tagName === 'body')!;
    const elements = [
      ...head.childNodes!.filter(
          (n: parse5.ASTNode) => n.tagName !== undefined),
      ...body.childNodes!.filter((n: parse5.ASTNode) => n.tagName !== undefined)
    ];

    const genericElements =
        elements.filter((e) => !elementBlacklist.has(e.tagName));
    if (genericElements.length === 0) {
      return;
    }
    const varName = `$_documentContainer`;
    const fragment = {
      nodeName: '#document-fragment',
      attrs: [],
      childNodes: genericElements,
    };
    const templateValue = nodeToTemplateLiteral(fragment as any, false);

    const statements = [
      jsc.variableDeclaration(
          'const', [jsc.variableDeclarator(
                       jsc.identifier(varName),
                       jsc.callExpression(
                           jsc.memberExpression(
                               jsc.identifier('document'),
                               jsc.identifier('createElement')),
                           [jsc.literal('div')]))]),
      jsc.expressionStatement(jsc.callExpression(
          jsc.memberExpression(
              jsc.identifier(varName), jsc.identifier('setAttribute')),
          [jsc.literal('style'), jsc.literal('display: none;')])),
      jsc.expressionStatement(jsc.assignmentExpression(
          '=',
          jsc.memberExpression(
              jsc.identifier(varName), jsc.identifier('innerHTML')),
          templateValue)),
      jsc.expressionStatement(jsc.callExpression(
          jsc.memberExpression(
              jsc.identifier('document'), jsc.identifier('appendChild')),
          [jsc.identifier(varName)]))
    ];
    let insertionPoint = 0;
    for (const [idx, statement] of enumerate(this.program.body)) {
      if (statement.type === 'ImportDeclaration') {
        continue;
      }
      // First stement past the imports.
      insertionPoint = idx;
      break;
    }
    this.program.body.splice(insertionPoint, 0, ...statements);
  }

  private rewriteNamespaceExports() {
    const exportMigrationRecords: NamespaceMemberToExport[] = [];
    let currentStatementIndex = 0;
    let localNamespaceName: string|undefined;
    let namespaceName: string|undefined;

    const rewriteNamespaceObject =
        (name: string,
         body: ObjectExpression,
         statement: Statement | ModuleDeclaration) => {
          const mutableExports = this._mutableExports[name];
          const namespaceExports = getNamespaceExports(body, mutableExports);

          // Replace original namespace statement with new exports
          const nsIndex = this.program.body.indexOf(statement);
          this.program.body.splice(
              nsIndex, 1, ...namespaceExports.map((e) => e.node));
          currentStatementIndex += namespaceExports.length - 1;
          for (const e of namespaceExports) {
            exportMigrationRecords.push({
              oldNamespacedName: `${name}.${e.name}`,
              es6ExportName: e.name
            });
          }
          exportMigrationRecords.push(
              {oldNamespacedName: name, es6ExportName: '*'});
        };

    // Walk through all top-level statements and replace namespace assignments
    // with module exports.
    while (currentStatementIndex < this.program.body.length) {
      const statement = this.program.body[currentStatementIndex] as Statement;
      const exported = getExport(statement, this.analysisConverter.namespaces);

      if (exported !== undefined) {
        const {namespace, value} = exported;
        namespaceName = namespace.join('.');

        if (this.isNamespace(statement) && value.type === 'ObjectExpression') {
          rewriteNamespaceObject(namespaceName, value, statement);
          localNamespaceName = namespaceName;
        } else if (value.type === 'Identifier') {
          // An 'export' of the form:
          // Polymer.Foo = Foo;
          // TODO(justinfagnani): generalize to handle namespaces and other
          // declarations
          const localName = value as Identifier;

          const features = this.document.getFeatures({id: namespaceName});
          // TODO(fks) 06-06-2017: '!' required below due to Typscript bug,
          // remove when fixed
          const referencedFeature = Array.from(features).find(
              (f) => f.identifiers.has(namespaceName!));

          if (referencedFeature && referencedFeature.kinds.has('namespace')) {
            // Polymer.X = X; where X is previously defined as a namespace

            // Find the namespace node and containing statement
            const namespaceFeature = referencedFeature as Namespace;
            const nsParent =
                this.getNode(namespaceFeature.astNode) as Statement;
            if (nsParent == null) {
              throw new Error(`can't find associated node for namespace`);
            }
            let nsNode: ObjectExpression;
            if (nsParent.type === 'VariableDeclaration') {
              // case: const n = {...}
              nsNode = nsParent.declarations[0].init as ObjectExpression;
            } else {
              // case: n = {...}
              // assumes an assignment statement!
              const expression = (nsParent as ExpressionStatement).expression as
                  AssignmentExpression;
              nsNode = expression.right as ObjectExpression;
            }
            rewriteNamespaceObject(namespaceName, nsNode, nsParent);

            // Remove the namespace assignment
            this.program.body.splice(currentStatementIndex, 1);
            // Adjust current index since we removed a statement
            currentStatementIndex--;
          } else {
            // Not a namespace, fallback to a named export
            // We could probably do better for referenced declarations, ie move
            // the export to the declaration
            const exportedName =
                jsc.identifier(namespace[namespace.length - 1]) as Identifier;
            this.program.body[currentStatementIndex] =
                jsc.exportNamedDeclaration(
                    null,  // declaration
                    [jsc.exportSpecifier(localName, exportedName)]);
            exportMigrationRecords.push({
              es6ExportName: exportedName.name,
              oldNamespacedName: namespaceName
            });
          }
        } else if (isDeclaration(value)) {
          // TODO (justinfagnani): remove this case? Is it used? Add a test
          this.program.body[currentStatementIndex] = jsc.exportDeclaration(
              false,  // default
              value);
        } else {
          let name = namespace[namespace.length - 1];
          // Special Polymer workaround: Register & rewrite the
          // `Polymer._polymerFn` export as if it were the `Polymer()`
          // namespace function.
          if (namespaceName === 'Polymer._polymerFn') {
            namespaceName = 'Polymer';
            name = 'Polymer';
          }
          this.program.body[currentStatementIndex] =
              jsc.exportNamedDeclaration(jsc.variableDeclaration(
                  'const',
                  [jsc.variableDeclarator(jsc.identifier(name), value)]));
          exportMigrationRecords.push(
              {oldNamespacedName: namespaceName, es6ExportName: name});
        }
      } else if (
          this.isNamespace(statement) &&
          statement.type === 'VariableDeclaration') {
        // Local namespace declaration, like:
        // /** @namespace */ const Foo = {};
        // Set the localNamespacename so we can rewrite internal references
        const declarator = statement.declarations[0];
        if (declarator.id.type === 'Identifier') {
          localNamespaceName = declarator.id.name;
        }
      } else if (localNamespaceName) {
        const namespaceAssignment =
            getExport(statement, new Set([localNamespaceName]));

        if (namespaceAssignment !== undefined) {
          const {namespace, value} = namespaceAssignment;
          const name = namespace[namespace.length - 1];
          namespaceName = namespace.join('.');

          this.program.body[currentStatementIndex] =
              jsc.exportNamedDeclaration(jsc.variableDeclaration(
                  'const',
                  [jsc.variableDeclarator(jsc.identifier(name), value)]));
          exportMigrationRecords.push(
              {oldNamespacedName: namespaceName, es6ExportName: name});
        }
      }
      currentStatementIndex++;
    }

    return {
      localNamespaceName,
      namespaceName,
      exportMigrationRecords,
    };
  }

  private inlineTemplates() {
    const elements = this.document.getFeatures({'kind': 'polymer-element'});
    for (const element of elements) {
      const domModule = element.domModule;
      if (domModule === undefined) {
        continue;
      }
      const template = dom5.query(domModule, (e) => e.tagName === 'template');
      if (template === null) {
        continue;
      }

      const templateLiteral = nodeToTemplateLiteral((template as any).content);
      const node = this.getNode(element.astNode)!;

      if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
        // A Polymer 2.0 class-based element
        node.body.body.splice(
            0,
            0,
            jsc.methodDefinition(
                'get',
                jsc.identifier('template'),
                jsc.functionExpression(
                    null, [], jsc.blockStatement([jsc.returnStatement(
                                  templateLiteral)]))));
      } else if (node.type === 'CallExpression') {
        // A Polymer hybrid/legacy factory function element
        (node.arguments[0] as ObjectExpression)
            .properties.splice(
                0,
                0,
                jsc.property(
                    'init', jsc.identifier('_template'), templateLiteral));
      }
    }
  }

  /**
   *  Convert dependencies first, so we know what exports they have.
   */
  private convertDependencies() {
    const htmlImports = this.getHtmlImports();
    for (const htmlImport of htmlImports) {
      const jsUrl = htmlUrlToJs(htmlImport.url, this.document.url);
      if (this.analysisConverter.modules.has(jsUrl)) {
        continue;
      }
      this.analysisConverter.convertDocument(htmlImport.document);
    }
  }

  /**
   * Rewrite namespaced references (ie, Polymer.Element) to the imported name
   * (ie, Element).
   *
   * Returns a Map of imports used for each module so import declarations can be
   * rewritten correctly.
   */
  private rewriteNamespacedReferences() {
    const analysisConverter = this.analysisConverter;
    const importedReferences = new Map<string, Set<string>>();

    /**
     * Add the given JsExport to the current module's `importedReferences` map.
     */
    const addToImportedReferences = (moduleExport: JsExport) => {
      const moduleJsUrl = htmlUrlToJs(moduleExport.url, this.document.url);
      let moduleImportedNames = importedReferences.get(moduleJsUrl);
      if (moduleImportedNames === undefined) {
        moduleImportedNames = new Set<string>();
        importedReferences.set(moduleJsUrl, moduleImportedNames);
      }
      moduleImportedNames.add(moduleExport.name);
    };

    astTypes.visit(this.program, {
      visitIdentifier(path: AstPath<Identifier>) {
        const memberName = path.node.name;
        const isRootModuleIdentifier =
            analysisConverter.namespaces.has(memberName);
        if (!isRootModuleIdentifier ||
            (path.parent && getMemberPath(path.parent.node))) {
          return false;
        }
        const moduleExport =
            analysisConverter.namespacedExports.get(memberName);
        if (!moduleExport) {
          return false;
        }
        // Store the imported reference & rewrite the Identifier
        const jsModule = analysisConverter.modules.get(moduleExport.url);
        addToImportedReferences(moduleExport);
        replacePathWithExportIdentifier(path, moduleExport, jsModule!);
        return false;
      },
      visitMemberExpression(path: AstPath<MemberExpression>) {
        const memberPath = getMemberPath(path.node);
        if (!memberPath) {
          this.traverse(path);
          return;
        }
        const memberName = memberPath.join('.');
        const moduleExport =
            analysisConverter.namespacedExports.get(memberName);
        if (!moduleExport) {
          this.traverse(path);
          return;
        }
        // Store the imported reference & rewrite the MemberExpression
        const jsModule = analysisConverter.modules.get(moduleExport.url);
        addToImportedReferences(moduleExport);
        replacePathWithExportIdentifier(path, moduleExport, jsModule!);
        return false;
      }
    });
    return importedReferences;
  }

  private rewriteExcludedReferences() {
    const analysisConverter = this.analysisConverter;

    astTypes.visit(this.program, {
      visitMemberExpression(path: any) {
        const memberPath = getMemberPath(path.node);
        if (memberPath) {
          const memberName = memberPath.join('.');
          if (analysisConverter._referenceExcludes.has(memberName)) {
            path.replace(jsc.identifier('undefined'));
          }
        }
        this.traverse(path);
      }
    });
  }

  /**
   * Rewrites local references to a namespace member, ie:
   *
   * const NS = {
   *   foo() {}
   * }
   * NS.foo();
   *
   * to:
   *
   * export foo() {}
   * foo();
   */
  private rewriteReferencesToTheLocallyDefinedNamespace(  //
      namespaceName?: string) {
    if (namespaceName === undefined) {
      return;
    }
    astTypes.visit(this.program, {
      visitMemberExpression(path: any) {
        const memberPath = getMemberPath(path.node);
        const memberName = memberPath && memberPath.slice(0, -1).join('.');
        if (memberName && memberName === namespaceName) {
          path.replace(path.node.property);
          return false;
        }
        // Keep looking, this MemberExpression could still contain the
        // MemberExpression that we are looking for.
        this.traverse(path);
        return;
      }
    });
  }

  /**
   * Rewrite `this` references that refer to the namespace object. Replace with
   * an explicit reference to the namespace. This simplifies the rest of our
   * transform pipeline by letting it assume that all namespace references
   * are explicit.
   *
   * NOTE(fks): References to the namespace object still need to be corrected
   * after this step, so timing is important: Only run after exports have
   * been created, but before all namespace references are corrected.
   */
  private rewriteNamespaceThisReferences(namespaceName?: string) {
    if (namespaceName === undefined) {
      return;
    }
    astTypes.visit(this.program, {
      visitExportNamedDeclaration: (path: any) => {
        if (path.node.declaration &&
            path.node.declaration.type === 'FunctionDeclaration') {
          this.rewriteSingleScopeThisReferences(
              path.node.declaration.body, namespaceName);
        }
        return false;
      },
      visitExportDefaultDeclaration: (path: any) => {
        if (path.node.declaration &&
            path.node.declaration.type === 'FunctionDeclaration') {
          this.rewriteSingleScopeThisReferences(
              path.node.declaration.body, namespaceName);
        }
        return false;
      },
    });
  }

  /**
   * Rewrite `this` references to the explicit namespaceReference identifier
   * within a single BlockStatement. Don't traverse deeper into new scopes.
   */
  private rewriteSingleScopeThisReferences(
      blockStatement: BlockStatement, namespaceReference: string) {
    astTypes.visit(blockStatement, {
      visitFunctionExpression(_path: any) {
        // Don't visit into new scopes
        return false;
      },
      visitFunctionDeclaration(_path: any) {
        // Don't visit into new scopes
        return false;
      },
      visitThisExpression(path: any) {
        path.replace(jsc.identifier(namespaceReference));
        return false;
      },
    });
  }

  /**
   * Injects JS imports at the top of the program.
   */
  private addJsImports(  //
      importedReferences: ReadonlyMap<string, ReadonlySet<string>>) {
    const baseUrl = this.document.url;
    const htmlImports = this.getHtmlImports();
    const jsImportUrls =
        new Set(htmlImports.map((s) => htmlUrlToJs(s.url, baseUrl)));

    // Rewrite HTML Imports to JS imports
    const jsImportDeclarations: any[] = [];
    for (const jsImportUrl of jsImportUrls) {
      const specifierNames = importedReferences.get(jsImportUrl);
      jsImportDeclarations.push(
          ...getImportDeclarations(jsImportUrl, specifierNames));
    }
    // Add JS imports for any implicit HTML imports
    for (const jsImplicitImportUrl of importedReferences.keys()) {
      if (!jsImportUrls.has(jsImplicitImportUrl)) {
        const specifierNames = importedReferences.get(jsImplicitImportUrl);
        jsImportDeclarations.push(
            ...getImportDeclarations(jsImplicitImportUrl, specifierNames));
      }
    }

    this.program.body.splice(0, 0, ...jsImportDeclarations);
  }

  /**
   * Returns the implied module body of a script - if there's a top-level IIFE,
   * it assumes that is an intentionally scoped ES5 module body.
   */
  private unwrapIIFEPeusdoModule() {
    if (this.program.body.length === 1 &&
        this.program.body[0].type === 'ExpressionStatement') {
      const expression =
          (this.program.body[0] as ExpressionStatement).expression;
      if (expression.type === 'CallExpression') {
        const callee = expression.callee;
        if (callee.type === 'FunctionExpression') {
          const body = callee.body.body;
          if (body.length > 1 && isUseStrict(body[0])) {
            this.program.body = body.slice(1);
          } else {
            this.program.body = body;
          }
        }
      }
    }
  }

  private isNamespace(node: Node) {
    if (this.document == null) {
      return false;
    }
    const namespaces = this.document.getFeatures({kind: 'namespace'});
    for (const namespace of namespaces) {
      if (sourceLocationsEqual(namespace.astNode, node)) {
        return true;
      }
    }
    return false;
  }

  private getNode(node: Node) {
    let associatedNode: Node|undefined;

    astTypes.visit(this.program, {
      visitNode(path: any): any {
        if (sourceLocationsEqual(path.node, node)) {
          associatedNode = path.node;
          return false;
        }
        this.traverse(path);
      }
    });

    return associatedNode;
  }
}

/**
 * Returns export declarations for each of a namespace objects members.
 *
 * Pure, does no mutation.
 */
function getNamespaceExports(
    namespace: ObjectExpression, mutableExports?: ReadonlyArray<string>) {
  const exportRecords: {name: string, node: Node}[] = [];

  for (const {key, value} of namespace.properties) {
    if (key.type !== 'Identifier') {
      console.warn(`unsupported namespace property type ${key.type}`);
      continue;
    }
    const name = (key as Identifier).name;
    if (value.type === 'ObjectExpression' || value.type === 'ArrayExpression' ||
        value.type === 'Literal') {
      const isMutable = !!(mutableExports && mutableExports.includes(name));
      exportRecords.push({
        name,
        node: jsc.exportNamedDeclaration(jsc.variableDeclaration(
            isMutable ? 'let' : 'const', [jsc.variableDeclarator(key, value)]))
      });
    } else if (value.type === 'FunctionExpression') {
      const func = value as FunctionExpression;
      exportRecords.push({
        name,
        node: jsc.exportNamedDeclaration(jsc.functionDeclaration(
            key,  // id
            func.params,
            func.body,
            func.generator))
      });
    } else if (value.type === 'ArrowFunctionExpression') {
      exportRecords.push({
        name,
        node: jsc.exportNamedDeclaration(jsc.variableDeclaration(
            'const', [jsc.variableDeclarator(key, value)]))
      });
    } else if (value.type === 'Identifier') {
      exportRecords.push({
        name,
        node: jsc.exportNamedDeclaration(
            null,
            [jsc.exportSpecifier(jsc.identifier(name), jsc.identifier(name))]),
      });
    } else {
      console.warn('Namespace property not handled:', name, value);
    }
  }

  return exportRecords;
}

/**
 * Returns true if a statement is the literal "use strict".
 */
function isUseStrict(statement: Statement) {
  return statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'Literal' &&
      statement.expression.value === 'use strict';
}

/**
 * Returns true if a node is a class or function declaration
 */
function isDeclaration(node: Node) {
  const type = node.type;
  return type === 'ClassDeclaration';
}

/**
 * If a statement appears to be an export, returns the exported declaration.
 *
 * Implied exports are assignment expressions where the left hand side matches
 * some predicate to be refined later :)
 *
 * @param moduleRoot If specified
 */
function getExport(
    statement: Statement|ModuleDeclaration, namespaces: ReadonlySet<string>):
    {namespace: string[], value: Expression}|undefined {
  if (!(statement.type === 'ExpressionStatement' &&
        statement.expression.type === 'AssignmentExpression')) {
    return undefined;
  }
  const assignment = statement.expression;
  if (!(assignment.left.type === 'MemberExpression')) {
    return undefined;
  }

  const namespace = getMemberPath(assignment.left);

  if (namespace !== undefined && namespaces.has(namespace[0])) {
    return {
      namespace,
      value: assignment.right,
    };
  }
  return undefined;
}

/**
 * Returns an array of identifiers if an expression is a chain of property
 * access, as used in namespace-style exports.
 */
export function getMemberPath(expression: Node): string[]|undefined {
  if (expression.type !== 'MemberExpression' ||
      expression.property.type !== 'Identifier') {
    return;
  }
  const property = expression.property.name;

  if (expression.object.type === 'ThisExpression') {
    return ['this', property];
  } else if (expression.object.type === 'Identifier') {
    if (expression.object.name === 'window') {
      return [property];
    } else {
      return [expression.object.name, property];
    }
  } else if (expression.object.type === 'MemberExpression') {
    const prefixPath = getMemberPath(expression.object);
    if (prefixPath !== undefined) {
      return [...prefixPath, property];
    }
  }
  return undefined;
}

/**
 * Get the import alias for an imported member. Useful when generating an
 * import statement or a reference to an imported member.
 */
function getImportAlias(importId: string) {
  return '$' + importId;
}

/**
 * Get the import name for an imported module object. Useful when generating an
 * import statement, or a reference to an imported module object.
 */
function getModuleId(url: string) {
  const baseName = path.basename(url);
  const lastDotIndex = baseName.lastIndexOf('.');
  const mainName = baseName.substring(0, lastDotIndex);
  return '$$' + dashToCamelCase(mainName);
}

function dashToCamelCase(s: string) {
  return s.replace(/-[a-z]/g, (m) => m[1].toUpperCase());
}

function sourceLocationsEqual(a: Node, b: Node): boolean {
  if (a === b) {
    return true;
  }
  const aLoc = a.loc;
  const bLoc = b.loc;
  if (aLoc === bLoc) {
    return true;
  }
  if (aLoc == null || bLoc == null) {
    return false;
  }
  return aLoc.start.column === bLoc.start.column &&
      aLoc.start.line === bLoc.start.line &&
      aLoc.end.column === bLoc.end.column && aLoc.end.line === bLoc.end.line;
}

function nodeToTemplateLiteral(
    node: parse5.ASTNode, addNewlines = true): estree.TemplateLiteral {
  const lines = parse5.serialize(node).split('\n');

  // Remove empty / whitespace-only leading lines.
  while (/^\s*$/.test(lines[0])) {
    lines.shift();
  }
  // Remove empty / whitespace-only trailing lines.
  while (/^\s*$/.test(lines[lines.length - 1])) {
    lines.pop();
  }

  let cooked = lines.join('\n');
  if (addNewlines) {
    cooked = `\n${cooked}\n`;
  }

  // The `\` -> `\\` replacement must occur first so that the backslashes
  // introduced by later replacements are not replaced.
  const raw =
      cooked.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

  return jsc.templateLiteral([jsc.templateElement({cooked, raw}, true)], []);
}


function* enumerate<V>(iter: Iterable<V>): Iterable<[number, V]> {
  let i = 0;
  for (const val of iter) {
    yield [i, val];
    i++;
  }
}
