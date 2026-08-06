import { parse } from "@babel/parser";
import traverse, { type Binding, type NodePath, type Scope } from "@babel/traverse";

export interface ModuleReference {
  readonly specifier: string;
  readonly line: number;
  readonly column: number;
}

interface StaticSpecifier {
  readonly path: NodePath;
  readonly value: string;
}

function isNodePath(value: unknown): value is NodePath {
  const node = (value as { readonly node?: unknown } | null)?.node;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof node === "object" &&
    node !== null &&
    "type" in node &&
    typeof (node as { readonly type?: unknown }).type === "string" &&
    "get" in value &&
    typeof (value as { readonly get?: unknown }).get === "function"
  );
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

function childPath(path: NodePath, key: string): NodePath | undefined {
  const child: unknown = path.get(key);
  return isNodePath(child) ? child : undefined;
}

function childPaths(path: NodePath, key: string): readonly NodePath[] {
  const children: unknown = path.get(key);
  return Array.isArray(children)
    ? children.filter(isNodePath)
    : [];
}

function unwrapPath(path: NodePath | undefined): NodePath | undefined {
  let current = path;
  while (current !== undefined) {
    if (transparentExpressionTypes.has(current.node.type)) {
      current = childPath(current, "expression");
      continue;
    }
    if (current.node.type === "SequenceExpression") {
      current = childPaths(current, "expressions").at(-1);
      continue;
    }
    return current;
  }
  return undefined;
}

function identifierName(path: NodePath | undefined): string | undefined {
  const current = unwrapPath(path);
  return current?.isIdentifier() === true ? current.node.name : undefined;
}

function memberPropertyName(path: NodePath): string | undefined {
  const member = unwrapPath(path);
  if (
    member === undefined ||
    (member.node.type !== "MemberExpression" &&
      member.node.type !== "OptionalMemberExpression")
  ) {
    return undefined;
  }
  const property = childPath(member, "property");
  if (member.node.computed) {
    return staticSpecifier(property)?.value;
  }
  return identifierName(property);
}

function bindingInitializer(binding: Binding): NodePath | undefined {
  const parent = binding.path.parentPath;
  const declaration = binding.path.isVariableDeclarator()
    ? binding.path
    : parent.isVariableDeclarator()
      ? parent
      : undefined;
  return declaration === undefined ? undefined : childPath(declaration, "init");
}

function bindingIsUnchangedBeforeUse(binding: Binding, usePath: NodePath): boolean {
  const useStart = usePath.node.start ?? Number.POSITIVE_INFINITY;
  const useExecutionScope = executionScope(usePath);
  return binding.constantViolations.every(
    (violation) =>
      !isSameOrAncestorScope(executionScope(violation), useExecutionScope) ||
      (violation.node.start ?? Number.NEGATIVE_INFINITY) >= useStart,
  );
}

function executionScope(path: NodePath): Scope {
  return path.scope.getFunctionParent() ?? path.scope.getProgramParent();
}

function isSameOrAncestorScope(candidate: Scope, scope: Scope): boolean {
  let current: Scope | null = scope;
  while (current !== null) {
    if (current === candidate) {
      return true;
    }
    current = current.parent ?? null;
  }
  return false;
}

function isUnboundIdentifier(path: NodePath, name: string): boolean {
  return identifierName(path) === name && path.scope.getBinding(name) === undefined;
}

function isRequireFunction(
  path: NodePath | undefined,
  usePath: NodePath,
  visitedBindings = new Set<Binding>(),
): boolean {
  const current = unwrapPath(path);
  if (current === undefined) {
    return false;
  }
  const name = identifierName(current);
  if (name !== undefined) {
    const binding = current.scope.getBinding(name);
    if (binding === undefined) {
      return name === "require";
    }
    if (
      visitedBindings.has(binding) ||
      !bindingIsUnchangedBeforeUse(binding, usePath)
    ) {
      return false;
    }
    const nextVisited = new Set(visitedBindings).add(binding);
    const initializer = bindingInitializer(binding);
    return isRequireFunction(initializer, initializer ?? usePath, nextVisited);
  }

  if (
    current.node.type === "MemberExpression" ||
    current.node.type === "OptionalMemberExpression"
  ) {
    const object = childPath(current, "object");
    return (
      memberPropertyName(current) === "require" &&
      object !== undefined &&
      isUnboundIdentifier(object, "module")
    );
  }

  if (current.node.type === "CallExpression") {
    const callee = unwrapPath(childPath(current, "callee"));
    if (
      callee !== undefined &&
      memberPropertyName(callee) === "bind"
    ) {
      return isRequireFunction(childPath(callee, "object"), usePath, visitedBindings);
    }
  }
  return false;
}

function staticSpecifier(path: NodePath | undefined): StaticSpecifier | undefined {
  const current = unwrapPath(path);
  if (current?.isStringLiteral() === true) {
    return { path: current, value: current.node.value };
  }
  if (current?.isTemplateLiteral() !== true || current.node.expressions.length > 0) {
    return undefined;
  }
  const cooked = current.node.quasis[0]?.value.cooked;
  return typeof cooked === "string" ? { path: current, value: cooked } : undefined;
}

function callSpecifier(path: NodePath): StaticSpecifier | undefined {
  const callee = unwrapPath(childPath(path, "callee"));
  const callArguments = childPaths(path, "arguments");
  if (callee?.node.type === "Import") {
    return staticSpecifier(callArguments[0]);
  }
  if (isRequireFunction(callee, path)) {
    return staticSpecifier(callArguments[0]);
  }
  if (
    callee === undefined ||
    (callee.node.type !== "MemberExpression" &&
      callee.node.type !== "OptionalMemberExpression")
  ) {
    return undefined;
  }
  const object = childPath(callee, "object");
  const propertyName = memberPropertyName(callee);
  if (propertyName === "resolve" && isRequireFunction(object, path)) {
    return staticSpecifier(callArguments[0]);
  }
  if (propertyName === "call" && isRequireFunction(object, path)) {
    return staticSpecifier(callArguments[1]);
  }
  return undefined;
}

function declarationSpecifier(path: NodePath): StaticSpecifier | undefined {
  if (
    path.node.type === "ImportDeclaration" ||
    path.node.type === "ExportAllDeclaration" ||
    path.node.type === "ExportNamedDeclaration"
  ) {
    return staticSpecifier(childPath(path, "source"));
  }
  if (path.node.type === "ImportExpression") {
    return staticSpecifier(childPath(path, "source"));
  }
  if (path.node.type === "TSImportType") {
    return staticSpecifier(childPath(path, "argument"));
  }
  if (path.node.type === "TSExternalModuleReference") {
    return staticSpecifier(childPath(path, "expression"));
  }
  return undefined;
}

function toModuleReference(specifier: StaticSpecifier): ModuleReference {
  const location = specifier.path.node.loc?.start;
  return {
    specifier: specifier.value,
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
  });
  const references: ModuleReference[] = [];
  traverse(ast, {
    enter(path: NodePath) {
      const specifier =
        declarationSpecifier(path) ??
        (path.node.type === "CallExpression" || path.node.type === "OptionalCallExpression"
          ? callSpecifier(path)
          : undefined);
      if (specifier !== undefined) {
        references.push(toModuleReference(specifier));
      }
    },
  });
  return references;
}
