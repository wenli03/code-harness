import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolve } from 'node:path'

import { IGNORED_DIRS, requireProjectPath, resolveInsideProject, toPosixPath } from '../src/main/agent/tools/paths.ts'

/**
 * 路径围栏是这个应用最重要的一条安全不变量：模型可以自由决定读哪个文件，
 * 但**不能**用 `../` 或绝对路径溜出项目根。这条逻辑一旦退化，`run_command` 的审批闸门
 * 就成了唯一的防线，而审批是用户点出来的，会疲劳。
 */
describe('resolveInsideProject：路径围栏', () => {
  const root = resolve('C:/proj/demo')

  it('允许项目内的相对路径，并解析成绝对路径', () => {
    assert.equal(resolveInsideProject(root, 'src/main.ts'), resolve(root, 'src/main.ts'))
    assert.equal(resolveInsideProject(root, 'a/b/c.txt'), resolve(root, 'a/b/c.txt'))
  })

  it('允许根目录自身', () => {
    assert.equal(resolveInsideProject(root, '.'), root)
  })

  it('拒绝 ../ 逃逸', () => {
    assert.throws(() => resolveInsideProject(root, '../secret.txt'), /路径越界/)
  })

  it('拒绝绕一圈再逃逸（a/../../x）', () => {
    assert.throws(() => resolveInsideProject(root, 'a/../../secret.txt'), /路径越界/)
  })

  it('拒绝绝对路径：即使它指向项目内的文件（只允许等于根目录本身）', () => {
    assert.throws(() => resolveInsideProject(root, 'C:/proj/demo/src/main.ts'), /不允许使用绝对路径/)
  })

  it('拒绝项目外的绝对路径（先被越界判定拦下）', () => {
    assert.throws(() => resolveInsideProject(root, 'C:/Windows/system32/config/sam'), /路径越界/)
  })

  it('拒绝前缀相同但不是同一目录的兄弟路径（demo-evil）', () => {
    assert.throws(() => resolveInsideProject(root, '../demo-evil/x.txt'), /路径越界/)
  })
})

describe('requireProjectPath', () => {
  it('没有关联项目时明确报错，而不是静默退化成当前目录', () => {
    assert.throws(() => requireProjectPath(null), /未关联项目目录/)
    assert.throws(() => requireProjectPath(''), /未关联项目目录/)
  })

  it('有项目时原样返回', () => {
    assert.equal(requireProjectPath('C:/proj/demo'), 'C:/proj/demo')
  })
})

describe('toPosixPath', () => {
  it('把平台分隔符统一成 /（转录与展示都依赖它）', () => {
    assert.equal(toPosixPath('src\\main\\index.ts'), 'src/main/index.ts')
  })
})

describe('IGNORED_DIRS', () => {
  it('必须覆盖依赖与构建产物目录，避免把它们喂给模型', () => {
    for (const dir of ['node_modules', '.git', 'out', 'dist', 'release', '__pycache__']) {
      assert.ok(IGNORED_DIRS.has(dir), `${dir} 应被忽略`)
    }
  })
})
