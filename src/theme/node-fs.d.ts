/** Just what colors.test.ts needs from Node (the project has no @types/node). */
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}
