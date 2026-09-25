import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  TOOL_APPROVAL_GROUPS,
  approvalGroupForTool,
  expandApprovalTools,
  groupApprovalState,
  toggleApprovalGroup
} from '../src/shared/tool-groups.ts'

/**
 * 审批分组决定「总是允许」到底放开了什么。这里守两条不变量：
 *  ① **整组授权**：点「总是允许编辑文件」必须同时覆盖 write_file 与 edit_file，
 *     否则用户点过一次之后还会被同一个类别再问一次，而他会以为自己已经授权过了；
 *  ② **不越界**：勾「编辑文件」绝不能连带放开 `run_command` —— 那是完全不同的风险等级。
 */
describe('expandApprovalTools：整组授权', () => {
  it('编辑类工具整组写入（write_file / edit_file 一次覆盖）', () => {
    const expanded = expandApprovalTools('edit_file')
    assert.ok(expanded.includes('write_file'))
    assert.ok(expanded.includes('edit_file'))
  })

  it('write_file 反查也应得到同一组', () => {
    assert.deepEqual(
      expandApprovalTools('write_file').slice().sort(),
      expandApprovalTools('edit_file').slice().sort()
    )
  })

  it('勾「编辑文件」不会放开 run_command（风险等级不同，不得连带）', () => {
    assert.ok(!expandApprovalTools('edit_file').includes('run_command'))
    assert.ok(!expandApprovalTools('write_file').includes('run_command'))
  })

  it('未分组的工具只写它自己', () => {
    assert.deepEqual(expandApprovalTools('some_future_tool'), ['some_future_tool'])
  })
})

describe('approvalGroupForTool', () => {
  it('只读工具不属于任何审批分组（它们本来就不弹审批）', () => {
    for (const readOnly of ['read_file', 'list_dir', 'glob', 'grep', 'git_status', 'git_diff']) {
      assert.equal(approvalGroupForTool(readOnly), null, `${readOnly} 不应进审批分组`)
    }
  })

  it('有副作用的工具必须落在某个分组里（漏一个就是漏一道闸门）', () => {
    for (const sideEffect of ['write_file', 'edit_file', 'run_command', 'git_commit']) {
      assert.ok(approvalGroupForTool(sideEffect), `${sideEffect} 必须被分组覆盖`)
    }
  })

  it('分组之间不允许重叠（否则勾选态会自相矛盾）', () => {
    const seen = new Map<string, string>()
    for (const group of TOOL_APPROVAL_GROUPS) {
      for (const tool of group.tools) {
        assert.ok(!seen.has(tool), `${tool} 同时出现在 ${seen.get(tool)} 与 ${group.id}`)
        seen.set(tool, group.id)
      }
    }
  })
})

describe('groupApprovalState', () => {
  const edit = TOOL_APPROVAL_GROUPS.find((g) => g.id === 'edit')!

  it('全部命中 = all', () => {
    assert.equal(groupApprovalState(edit, edit.tools.slice()), 'all')
  })

  it('一个都没命中 = none', () => {
    assert.equal(groupApprovalState(edit, []), 'none')
  })

  it('部分命中 = partial（设置界面要能看出来，否则用户会误判自己已全放开）', () => {
    assert.equal(groupApprovalState(edit, [edit.tools[0]]), 'partial')
  })
})

describe('toggleApprovalGroup', () => {
  it('开启时把整组加进来', () => {
    const edit = TOOL_APPROVAL_GROUPS.find((g) => g.id === 'edit')!
    const next = toggleApprovalGroup(edit, [], true)
    assert.deepEqual(next.slice().sort(), edit.tools.slice().sort())
  })

  it('关闭时只摘掉本组，不动其他组的授权', () => {
    const edit = TOOL_APPROVAL_GROUPS.find((g) => g.id === 'edit')!
    const shell = TOOL_APPROVAL_GROUPS.find((g) => g.id === 'shell')!
    const next = toggleApprovalGroup(edit, [...edit.tools, ...shell.tools], false)
    assert.deepEqual(next, shell.tools)
  })
})
