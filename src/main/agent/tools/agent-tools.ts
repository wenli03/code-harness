import { randomUUID } from 'node:crypto'
import type { TodoItem } from '@shared/types'
import { asOptionalString, asString } from './args'
import { ocrReviewTool } from './ocr-tools'
import { reviewChangesTool } from './review-tools'
import { installSkillPackTool } from './skill-pack-tools'
import type { ToolDefinition } from './types'
import { toolError, toolOk } from './types'

const TODO_STATUSES: TodoItem['status'][] = ['pending', 'in_progress', 'completed', 'cancelled']

/**
 * 待办：与 UI 的「任务」面板实时同步，让模型显式维护多步计划。
 * acceptance 字段是针对"大需求拆不开、拆开了没法验收"的闸口：每项必须写"怎么算做完"，
 * 它会随任务清单进压缩快照（session.ts buildWorkSnapshot），长任务失忆后验收标准仍在场。
 */
export const todoWriteTool: ToolDefinition = {
  schema: {
    name: 'todo_write',
    description:
      '创建/更新当前任务的待办清单（覆盖式）。大需求先拆成可独立验证的小任务再写计划，每项带 acceptance（验收标准：验证命令或可检查的行为）；完成一步就更新状态，验收没跑通不得标 completed。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整清单，每项含 content、status 与 acceptance',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '任务描述（单一、可独立完成）' },
              status: {
                type: 'string',
                description: 'pending | in_progress | completed | cancelled',
                enum: ['pending', 'in_progress', 'completed', 'cancelled']
              },
              acceptance: {
                type: 'string',
                description: '怎么算做完：可执行的验证方式（命令、测试名、可检查的行为），写不出验收标准说明这项拆得不够小'
              }
            }
          }
        }
      },
      required: ['todos']
    }
  },
  async run(args, ctx) {
    const raw = args.todos
    if (!Array.isArray(raw)) return toolError('todos 必须是数组')

    const todos: TodoItem[] = raw.map((item) => {
      if (typeof item === 'string') return { id: randomUUID(), content: item, status: 'pending' }
      const record = (item ?? {}) as Record<string, unknown>
      const status = String(record.status ?? 'pending')
      const acceptance = asOptionalString(record, 'acceptance')?.trim()
      return {
        id: randomUUID(),
        content: String(record.content ?? record.text ?? ''),
        status: TODO_STATUSES.includes(status as TodoItem['status'])
          ? (status as TodoItem['status'])
          : 'pending',
        ...(acceptance ? { acceptance } : {})
      }
    })

    if (!todos.length) return toolError('todos 不能为空')
    ctx.setTodos(todos)
    const missing = todos.filter((t) => !t.acceptance && t.status !== 'cancelled').length
    const lines = todos
      .map((t) => `- [${t.status}] ${t.content}${t.acceptance ? `（验收：${t.acceptance}）` : ''}`)
      .join('\n')
    const nudge =
      missing > 0 ? `\n提醒：${missing} 项没有 acceptance 验收标准——无法验证的任务不算拆完。` : ''
    return toolOk(`待办已更新（${todos.length} 项）\n${lines}${nudge}`)
  }
}

/** 子智能体：派生子会话，独立上下文与工具循环，只回传结论。 */
export const taskTool: ToolDefinition = {
  schema: {
    name: 'task',
    description:
      '派生一个子智能体独立完成一段子任务（例如"通读某模块并总结对外接口"）。它有独立的上下文与文件/命令工具，看不到你的历史，最后只把结论返回给你。适合隔离重上下文的工作。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '交给子智能体的完整任务描述' },
        title: { type: 'string', description: '子会话标题，便于在界面中识别' }
      },
      required: ['prompt']
    }
  },
  async run(args, ctx) {
    const prompt = asString(args, 'prompt')
    const title = asOptionalString(args, 'title')
    try {
      const result = await ctx.spawnSubAgent({ prompt, title })
      return toolOk(result || '(子智能体未返回内容)')
    } catch (error) {
      return toolError(`子智能体失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** 长期目标：跨轮次保持并注入系统提示词。 */
export const setGoalTool: ToolDefinition = {
  schema: {
    name: 'set_goal',
    description:
      '为当前会话设置跨轮次保持的长期目标。确认这是需要持续多轮推进的大目标时使用，之后每轮都会看到它。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '目标的完整、可判定描述' }
      },
      required: ['goal']
    }
  },
  async run(args, ctx) {
    const goal = asString(args, 'goal')
    await ctx.setGoal(goal)
    return toolOk(`已记录长期目标：${goal}`)
  }
}

/** 长期记忆：必须带证据，避免把猜测固化成"事实"。 */
export const addMemoryTool: ToolDefinition = {
  schema: {
    name: 'add_memory',
    description:
      '把一条已确认的项目事实或约定写入长期记忆（会注入后续所有会话的系统提示词）。必须给出证据来源。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的事实/约定' },
        evidence: { type: 'string', description: '证据：文件路径、代码位置或用户原话' }
      },
      required: ['text', 'evidence']
    }
  },
  async run(args, ctx) {
    const text = asString(args, 'text')
    const evidence = asString(args, 'evidence')
    await ctx.rememberMemory({ text, evidence })
    return toolOk(`已记住：${text}`)
  }
}

/**
 * 工作方式改进（Harness 精炼）：与长期记忆的区别是「可被推翻的经验」——
 * 记忆记的是项目事实，精炼记的是做法（例如"这个仓库的测试必须先跑 build"）。
 */
export const addRefinementTool: ToolDefinition = {
  schema: {
    name: 'add_refinement',
    description:
      '沉淀一条"做法层面"的经验（不是项目事实），例如踩过的坑、必须遵守的操作顺序。会注入后续轮次的系统提示词。必须给出证据。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一条可执行的经验，写成行动指引' },
        evidence: { type: 'string', description: '证据：出错信息、命令输出或代码位置' }
      },
      required: ['text', 'evidence']
    }
  },
  async run(args, ctx) {
    const text = asString(args, 'text')
    const evidence = asString(args, 'evidence')
    await ctx.rememberRefinement({ text, evidence })
    return toolOk(`已沉淀经验：${text}`)
  }
}

export const agentTools: ToolDefinition[] = [
  todoWriteTool,
  taskTool,
  setGoalTool,
  addMemoryTool,
  addRefinementTool,
  reviewChangesTool,
  ocrReviewTool,
  installSkillPackTool
]
