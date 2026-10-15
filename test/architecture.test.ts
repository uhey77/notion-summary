/// <reference types="vite/client" />
import ts from "typescript";
import { expect, it } from "vitest";

const sources = import.meta.glob<string>("../src/**/*.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});
const moduleRoot = "modules/summary/";

function layer(path: string): string {
  return path.startsWith(moduleRoot)
    ? path.slice(moduleRoot.length).split("/")[0]
    : path.split("/")[0];
}

it("全レイヤーの依存は内側へ向かい、apiとconfigに実装を逆流させない", () => {
  const allowed: Record<string, string[]> = {
    domain: ["domain"],
    application: ["domain", "application"],
    infrastructure: ["domain", "application", "infrastructure"],
    api: ["api", "domain", "application"],
    config: ["config", "domain", "application"],
  };
  const violations: string[] = [];
  for (const [file, content] of Object.entries(sources)) {
    const path = file.replace("../src/", "");
    if (path === "index.ts") continue; // composition rootは具体実装を組み立てる。
    const owner = layer(path);
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      let specifier: string | undefined;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifier = node.moduleSpecifier.text;
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) specifier = argument.text;
        else violations.push(`${path}: dynamic import must use a literal`);
      }
      if (specifier) {
        if (specifier.startsWith(".")) {
          const target = new URL(specifier, `https://source.test/${path}`).pathname.slice(1);
          if (!allowed[owner]?.includes(layer(target))) violations.push(`${path} -> ${target}`);
        } else if (owner !== "infrastructure") {
          violations.push(`${path} -> ${specifier}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});
