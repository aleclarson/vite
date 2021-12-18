import path from 'path'
import { execSync } from 'child_process'
import { createServer, ViteDevServer } from '..'
import { TreeShaking } from '../treeshake'
import { pathExistsSync } from 'fs-extra'

let server: ViteDevServer

beforeAll(async () => {
  const root = path.resolve(__dirname, 'fixtures/yarn')
  if (!pathExistsSync(path.join(root, 'node_modules/lodash-es'))) {
    execSync(`npm i lodash-es --no-package-lock`, { cwd: root })
  }
  server = await createServer({ root, configFile: false })
})

afterAll(async () => {
  await server.close()
})

describe('TreeShaking', () => {
  it('works', async () => {
    const treeshake = new TreeShaking(server)
    const result = await treeshake.importFrom('lodash-es', 'add')

    expect(result.code).toMatchSnapshot()
  })
})
