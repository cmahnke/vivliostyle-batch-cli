import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import commonjs from "@rollup/plugin-commonjs";
import { dts } from "rollup-plugin-dts";
import { builtinModules } from "module";

const external = [...builtinModules, ...builtinModules.map((m) => `node:${m}`), /^[^./]/];

const configs = [
  {
    input: "./src/vivliostyle-cli.ts",
    external,
    output: {
      file: "dist/vivliostyle-batch-cli.js",
      format: "es"
    },
    plugins: [
      nodeResolve(),
      commonjs(),
      typescript({
        tsconfig: "./tsconfig.json",
        compilerOptions: {
          outDir: "dist"
        }
      })
    ]
  },
  {
    input: "./src/vivliostyle-cli.ts",
    external,
    output: {
      file: "dist/index.d.ts",
      format: "es"
    },
    plugins: [dts()]
  }
];

export default configs;
