import { parse } from "@babel/parser";

export interface ModuleReference {
  readonly specifier: string;
  readonly line: number;
  readonly column: number;
}

interface AstNode {
  readonly type: string;
  readonly loc?: {
    readonly start: { readonly line: number; readonly column: number };
  } | null;
  readonly [key: string]: unknown;
}

const transparentExpressionTypes = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "TypeCastExpression",
]);

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "type" in value &&
    typeof (value as { readonly type?: unknown }).type === "string";
}

function walkAst(value: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkAst(entry, visit);
    }
    return;
  }
  if (!isAstNode(value)) {
    return;
  }
  visit(value);
  for (const child of Object.values(value)) {
    if (isAstNode(child) || Array.isArray(child)) {
      walkAst(child, visit);
    }
  }
}

function unwrapExpression(value: unknown): AstNode | undefined {
  let current = isAstNode(value) ? value : undefined;
  while (current !== undefined) {
    if (transparentExpressionTypes.has(current.type)) {
      current = isAstNode(current.expression) ? current.expression : undefined;
      continue;
    }
    if (current.type === "SequenceExpression" && Array.isArray(current.expressions)) {
      const finalExpression: unknown = (current.expressions as unknown[]).at(-1);
      current = isAstNode(finalExpression) ? finalExpression : undefined;
      continue;
    }
    return current;
  }
  return undefined;
}

function identifierName(value: unknown): string | undefined {
  const node = unwrapExpression(value);
  return node?.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : undefined;
}

function resolvesToRequire(value: unknown, aliases: ReadonlySet<string>): boolean {
  const name = identifierName(value);
  return name !== undefined && aliases.has(name);
}

function aliasCandidate(node: AstNode): {
  readonly name: string;
  readonly value: unknown;
} | undefined {
  if (node.type === "VariableDeclarator") {
    const name = identifierName(node.id);
    return name === undefined ? undefined : { name, value: node.init };
  }
  if (node.type === "AssignmentExpression" && node.operator === "=") {
    const name = identifierName(node.left);
    return name === undefined ? undefined : { name, value: node.right };
  }
  return undefined;
}

function collectRequireAliases(root: AstNode): ReadonlySet<string> {
  const aliases = new Set(["require"]);
  let changed = true;
  while (changed) {
    changed = false;
    walkAst(root, (node) => {
      const candidate = aliasCandidate(node);
      if (
        candidate !== undefined &&
        !aliases.has(candidate.name) &&
        resolvesToRequire(candidate.value, aliases)
      ) {
        aliases.add(candidate.name);
        changed = true;
      }
    });
  }
  return aliases;
}

function isRequireCall(node: AstNode, aliases: ReadonlySet<string>): boolean {
  if (resolvesToRequire(node.callee, aliases)) {
    return true;
  }
  const callee = unwrapExpression(node.callee);
  if (callee?.type !== "MemberExpression" && callee?.type !== "OptionalMemberExpression") {
    return false;
  }
  const propertyName = identifierName(callee.property);
  return (
    (resolvesToRequire(callee.object, aliases) && propertyName === "resolve") ||
    (identifierName(callee.object) === "module" && propertyName === "require")
  );
}

function stringLiteral(value: unknown): AstNode | undefined {
  const node = unwrapExpression(value);
  return node?.type === "StringLiteral" && typeof node.value === "string"
    ? node
    : undefined;
}

function callArgument(node: AstNode): AstNode | undefined {
  if (!Array.isArray(node.arguments)) {
    return undefined;
  }
  return stringLiteral(node.arguments[0]);
}

function referencedLiteral(
  node: AstNode,
  requireAliases: ReadonlySet<string>,
): AstNode | undefined {
  if (
    node.type === "ImportDeclaration" ||
    node.type === "ExportAllDeclaration" ||
    node.type === "ExportNamedDeclaration"
  ) {
    return stringLiteral(node.source);
  }
  if (node.type === "ImportExpression" || node.type === "TSImportType") {
    return stringLiteral(node.source ?? node.argument);
  }
  if (node.type === "TSExternalModuleReference") {
    return stringLiteral(node.expression);
  }
  if (
    (node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
    (isRequireCall(node, requireAliases) || identifierName(node.callee) === "import")
  ) {
    return callArgument(node);
  }
  return undefined;
}

function toModuleReference(node: AstNode): ModuleReference {
  const location = node.loc?.start;
  return {
    specifier: node.value as string,
    line: location?.line ?? 1,
    column: (location?.column ?? 0) + 1,
  };
}

export function collectModuleReferences(
  sourceText: string,
  filePath: string,
): readonly ModuleReference[] {
  const ast = parse(sourceText, {
    allowAwaitOutsideFunction: true,
    createParenthesizedExpressions: true,
    plugins: ["typescript", "jsx"],
    sourceFilename: filePath,
    sourceType: "unambiguous",
  }) as unknown as AstNode;
  const requireAliases = collectRequireAliases(ast);
  const references: ModuleReference[] = [];
  walkAst(ast, (node) => {
    const literal = referencedLiteral(node, requireAliases);
    if (literal !== undefined) {
      references.push(toModuleReference(literal));
    }
  });
  return references;
}
