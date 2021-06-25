import { ssrTransform } from '../ssrTransform'

const transform = (code: string, url?: string) =>
  ssrTransform(code, null, url, false).then((res) => res.code)

test('default import', async () => {
  expect(await transform(`import foo from 'vue';\n` + `console.log(foo.bar)`))
    .toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const import_vue = await __vite_ssr_import__(\\"vue\\");
    console.log(import_vue.default.bar)"
  `)
})

test('named import', async () => {
  expect(
    await transform(
      `import { ref } from 'vue';\n` + `function foo() { return ref(0) }`
    )
  ).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const import_vue = await __vite_ssr_import__(\\"vue\\");
    function foo() { return import_vue.ref(0) }"
  `)
})

test('namespace import', async () => {
  expect(
    await transform(
      `import * as vue from 'vue';\n` + `function foo() { return vue.ref(0) }`
    )
  ).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const import_vue = await __vite_ssr_import__(\\"vue\\");
    function foo() { return import_vue.ref(0) }"
  `)
})

test('export function declaration', async () => {
  expect(await transform(`export function foo() {}`)).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    function foo() {}
    Object.defineProperty(__vite_ssr_exports__, \\"foo\\", { enumerable: true, configurable: true, get(){ return foo }});"
  `)
})

test('export class declaration', async () => {
  expect(await transform(`export class foo {}`)).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    class foo {}
    Object.defineProperty(__vite_ssr_exports__, \\"foo\\", { enumerable: true, configurable: true, get(){ return foo }});"
  `)
})

test('export var declaration', async () => {
  expect(await transform(`export const a = 1, b = 2`)).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const a = 1, b = 2
    Object.defineProperty(__vite_ssr_exports__, \\"a\\", { enumerable: true, configurable: true, get(){ return a }});
    Object.defineProperty(__vite_ssr_exports__, \\"b\\", { enumerable: true, configurable: true, get(){ return b }});"
  `)
})

test('export named', async () => {
  expect(await transform(`const a = 1, b = 2; export { a, b as c }`))
    .toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const a = 1, b = 2; 
    Object.defineProperty(__vite_ssr_exports__, \\"a\\", { enumerable: true, configurable: true, get(){ return a }});
    Object.defineProperty(__vite_ssr_exports__, \\"c\\", { enumerable: true, configurable: true, get(){ return b }});"
  `)
})

test('export named from', async () => {
  expect(await transform(`export { ref, computed as c } from 'vue'`))
    .toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const import_vue = await __vite_ssr_import__(\\"vue\\");
    Object.defineProperty(__vite_ssr_exports__, \\"ref\\", { enumerable: true, configurable: true, get(){ return import_vue.ref }});
    Object.defineProperty(__vite_ssr_exports__, \\"c\\", { enumerable: true, configurable: true, get(){ return import_vue.computed }});"
  `)
})

test('named exports of imported binding', async () => {
  expect(
    await transform(`import {createApp} from 'vue';\n` + `export {createApp}`)
  ).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const import_vue = await __vite_ssr_import__(\\"vue\\");

    Object.defineProperty(__vite_ssr_exports__, \\"createApp\\", { enumerable: true, configurable: true, get(){ return import_vue.createApp }});"
  `)
})

test('export * from', async () => {
  expect(await transform(`export * from 'vue'`)).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const import_vue = await __vite_ssr_import__(\\"vue\\");__vite_ssr_exportAll__(import_vue);"
  `)
})

test('export default', async () => {
  expect(await transform(`export default {}`)).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    __vite_ssr_exports__.default = {}"
  `)
})

test('import.meta', async () => {
  expect(await transform(`console.log(import.meta.url)`))
    .toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    console.log(__vite_ssr_import_meta__.url)"
  `)
})

test('dynamic import', async () => {
  expect(await transform(`export const i = () => import('./foo')`))
    .toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const i = () => __vite_ssr_dynamic_import__('./foo')
    Object.defineProperty(__vite_ssr_exports__, \\"i\\", { enumerable: true, configurable: true, get(){ return i }});"
  `)
})

test('do not rewrite method definition', async () => {
  expect(
    await transform(`import { fn } from 'vue';\n` + `class A { fn() { fn() } }`)
  ).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const import_vue = await __vite_ssr_import__(\\"vue\\");
    class A { fn() { import_vue.fn() } }"
  `)
})

test('do not rewrite catch clause', async () => {
  expect(
    await transform(
      `import {error} from './dependency';\n` + `try {} catch(error) {}`
    )
  ).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const import_dependency = await __vite_ssr_import__(\\"./dependency\\");
    try {} catch(error) {}"
  `)
})

// #2221
test('should declare variable for imported super class', async () => {
  expect(
    await transform(
      `import { Foo } from './dependency';\n` + `class A extends Foo {}`
    )
  ).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const import_dependency = await __vite_ssr_import__(\\"./dependency\\");
    const Foo = import_dependency.Foo;
    class A extends Foo {}"
  `)

  // exported classes: should prepend the declaration at root level, before the
  // first class that uses the binding
  expect(
    await transform(
      `import { Foo } from './dependency';\n` +
        `export default class A extends Foo {}\n` +
        `export class B extends Foo {}`
    )
  ).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const import_dependency = await __vite_ssr_import__(\\"./dependency\\");
    const Foo = import_dependency.Foo;
    __vite_ssr_exports__.default = class A extends Foo {}
    class B extends Foo {}
    Object.defineProperty(__vite_ssr_exports__, \\"B\\", { enumerable: true, configurable: true, get(){ return B }});"
  `)
})

test('sourcemap source', async () => {
  expect(
    (await ssrTransform(`export const a = 1`, null, 'input.js', false)).map
      .sources
  ).toStrictEqual(['input.js'])
})

test('overwrite bindings', async () => {
  expect(
    await transform(
      `import { inject } from 'vue';\n` +
        `const a = { inject }\n` +
        `const b = { test: inject }\n` +
        `function c() { const { test: inject } = { test: true }; console.log(inject) }\n` +
        `const d = inject \n` +
        `function f() {  console.log(inject) }\n` +
        `function e() { const { inject } = { inject: true } }\n`
    )
  ).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const import_vue = await __vite_ssr_import__(\\"vue\\");
    const a = { inject: import_vue.inject }
    const b = { test: import_vue.inject }
    function c() { const { test: inject } = { test: true }; console.log(inject) }
    const d = import_vue.inject 
    function f() {  console.log(import_vue.inject) }
    function e() { const { inject } = { inject: true } }
    "
  `)
})

test('duplicate import basename', async () => {
  expect(
    await transform(`import {a} from 'vue';\n` + `import {b} from '@foo/vue';`)
  ).toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const import_vue = await __vite_ssr_import__(\\"vue\\");
    const import_vue_2 = await __vite_ssr_import__(\\"@foo/vue\\");"
  `)
})

test('commonjs false positive', async () => {
  expect(await transform(`export const exports = require("foo")`))
    .toMatchInlineSnapshot(`
    "Object.defineProperty(__vite_ssr_exports__, \\"__esModule\\", {value: true});
    const exports = require(\\"foo\\")
    Object.defineProperty(__vite_ssr_exports__, \\"exports\\", { enumerable: true, configurable: true, get(){ return exports }});"
  `)
})

describe('commonjs', () => {
  test('require call', async () => {
    expect(await transform(`const foo = require("foo")`)).toMatchInlineSnapshot(
      `"const foo = __vite_ssr_import__(\\"foo\\")"`
    )
  })

  test('module.exports assignment', async () => {
    expect(await transform(`module.exports = 1`)).toMatchInlineSnapshot(
      `"__vite_ssr_exports__.default = 1"`
    )
  })

  test('module.exports property assignment', async () => {
    expect(await transform(`module.exports.foo = 1`)).toMatchInlineSnapshot(
      `"__vite_ssr_exports__.foo = 1"`
    )
  })

  test('module.exports reference', async () => {
    expect(await transform(`foo(module.exports)`)).toMatchInlineSnapshot(
      `"foo(__vite_ssr_exports__)"`
    )
  })

  test('module.exports property reference', async () => {
    expect(await transform(`foo(module.exports.foo)`)).toMatchInlineSnapshot(
      `"foo(__vite_ssr_exports__.foo)"`
    )
  })

  test('exports property assignment', async () => {
    expect(await transform(`exports.foo = 1`)).toMatchInlineSnapshot(
      `"__vite_ssr_exports__.foo = 1"`
    )
  })

  test('exports property reference', async () => {
    expect(await transform(`foo(exports.foo)`)).toMatchInlineSnapshot(
      `"foo(__vite_ssr_exports__.foo)"`
    )
  })
})
