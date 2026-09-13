import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const MCP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function unwrapExpression(node) {
  let current = node;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function sourceToolSpecs(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const commonObjects = new Map();
  const tools = [];

  const visitCommons = (node) => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isObjectLiteralExpression(unwrapExpression(node.initializer))) {
      commonObjects.set(node.name.text, unwrapExpression(node.initializer));
    }
    ts.forEachChild(node, visitCommons);
  };
  visitCommons(file);

  const resolvedProperty = (object, name) => {
    let found = null;
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
        const common = commonObjects.get(property.expression.text);
        if (common) found = resolvedProperty(common, name) ?? found;
      } else if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) {
        found = unwrapExpression(property.initializer);
      } else if (ts.isMethodDeclaration(property) && propertyName(property.name) === name) {
        found = property;
      }
    }
    return found;
  };
  const stringValue = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
  const booleanValue = (node) => node?.kind === ts.SyntaxKind.TrueKeyword
    ? true
    : node?.kind === ts.SyntaxKind.FalseKeyword ? false : null;
  const numberValue = (node) => node && ts.isNumericLiteral(node) ? Number(node.text) : null;
  const stringArray = (node) => node && ts.isArrayLiteralExpression(node)
    ? node.elements.filter(ts.isStringLiteral).map((entry) => entry.text)
    : null;

  const visitSpecs = (node) => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && (node.expression.text === 'defineCanonicalToolSpecs' || node.expression.text === 'defineDomainToolSpecs')
      && node.arguments[0]
      && ts.isArrayLiteralExpression(unwrapExpression(node.arguments[0]))) {
      for (const element of unwrapExpression(node.arguments[0]).elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        const definition = resolvedProperty(element, 'definition');
        if (!definition || !ts.isObjectLiteralExpression(definition)) continue;
        const name = stringValue(resolvedProperty(definition, 'name'));
        const group = stringValue(resolvedProperty(element, 'group'));
        const surfaces = stringArray(resolvedProperty(element, 'surfaces'));
        const visibility = stringValue(resolvedProperty(element, 'visibility'));
        const core = booleanValue(resolvedProperty(element, 'core'));
        const paid = booleanValue(resolvedProperty(element, 'paid'));
        const coreRank = numberValue(resolvedProperty(element, 'coreRank'));
        const annotations = resolvedProperty(element, 'annotations');
        const outputSchema = resolvedProperty(definition, 'outputSchema');
        const protocol = resolvedProperty(element, 'protocol');
        // A deprecated alias: callable on its surfaces, but not advertised.
        const aliasOf = stringValue(resolvedProperty(element, 'aliasOf'));
        // Hidden spec: callable but not advertised (dashboard/HIDDEN-FEATURES.md).
        const hidden = booleanValue(resolvedProperty(element, 'hidden'));
        const execute = resolvedProperty(element, 'execute');
        if (!name || !group || !surfaces || !visibility || core === null || paid === null || !annotations || !execute) {
          throw new Error(`Incomplete canonical ToolSpec in ${path}: ${name ?? '(unnamed)'}`);
        }
        const oauthScopes = protocol && ts.isObjectLiteralExpression(protocol)
          ? stringArray(resolvedProperty(protocol, 'oauthScopes')) ?? []
          : [];
        const parsedAnnotations = ts.isObjectLiteralExpression(annotations)
          ? Object.fromEntries(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']
            .map((key) => [key, booleanValue(resolvedProperty(annotations, key))])
            .filter(([, value]) => value !== null))
          : {};
        tools.push({
          name,
          definition: { name },
          group,
          surfaces,
          visibility,
          ...(aliasOf ? { aliasOf } : {}),
          ...(hidden ? { hidden } : {}),
          core,
          ...(coreRank === null ? {} : { coreRank }),
          paid,
          oauthScopes,
          annotations: parsedAnnotations,
          hasAnnotations: ts.isObjectLiteralExpression(annotations),
          hasExecute: true,
          definitionSource: definition.getText(file),
          hasOutputSchema: outputSchema !== null,
          handlerSource: execute.getText(file),
          specSource: element.getText(file),
          sourcePath: path,
        });
      }
    }
    ts.forEachChild(node, visitSpecs);
  };
  visitSpecs(file);
  return tools;
}

export function readRegisteredToolSource() {
  const indexPath = join(MCP_ROOT, 'src/index.ts');
  const rawIndex = readFileSync(indexPath, 'utf8');
  const domainsDir = join(MCP_ROOT, 'src/tool-registry/domains');
  const domainSources = readdirSync(domainsDir)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => {
      const path = join(domainsDir, name);
      return { path, source: readFileSync(path, 'utf8') };
    });
  const toolSpecs = [
    ...sourceToolSpecs(indexPath, rawIndex),
    ...domainSources.flatMap(({ path, source }) => sourceToolSpecs(path, source)),
  ];
  const registeredToolNames = toolSpecs.map((tool) => tool.name);
  const duplicates = registeredToolNames.filter((name, index) => registeredToolNames.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate canonical ToolSpecs: ${[...new Set(duplicates)].join(', ')}`);
  }
  return {
    rawIndex,
    domainSources,
    toolSpecs,
    registeredToolNames,
  };
}
