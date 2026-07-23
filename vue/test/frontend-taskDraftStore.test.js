import { describe, expect, it } from 'vitest'
import { createTaskDraftStore } from '../src/stores/taskDraftStore.js'

function task(overrides = {}) {
  return {
    id: '1',
    task: '每日对账',
    start: '09:00:00',
    finish: '09:30:00',
    bot: '财务机器人',
    schedule_uuid: 'schedule-1',
    tags: ['财务'],
    note: '',
    version: 3,
    can_edit: true,
    normalized_status: '待运行',
    ...overrides,
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('task draft store', () => {
  it('只为变化字段生成带版本号的 update mutation', () => {
    const store = createTaskDraftStore(async () => ({ tasks: [], serverTime: null }))
    store._hydrateForTest([task()])

    store.updateTask('1', { note: '月底优先处理', tags: ['财务', '月结', '财务'] })

    expect(store.mutationList.value).toEqual([{
      type: 'update',
      id: '1',
      version: 3,
      changes: { tags: ['财务', '月结'], note: '月底优先处理' },
    }])
    expect(store.hasUnsaved.value).toBe(true)
  })

  it('现有任务更新不会修改或提交 schedule_uuid', () => {
    const store = createTaskDraftStore(async () => ({ tasks: [], serverTime: null }))
    store._hydrateForTest([task()])

    store.updateTask('1', { schedule_uuid: 'schedule-2', note: '保持原绑定' })

    expect(store.tasks.value[0].schedule_uuid).toBe('schedule-1')
    expect(store.mutationList.value).toEqual([{
      type: 'update',
      id: '1',
      version: 3,
      changes: { note: '保持原绑定' },
    }])
  })

  it('轮询刷新保留草稿字段但更新运行状态', async () => {
    let response = { tasks: [task()], serverTime: '2026-07-22T10:00:00Z' }
    const store = createTaskDraftStore(async () => response)
    await store.load()
    store.updateTask('1', { task: '每日对账（新版）' })
    response = {
      tasks: [task({ task: '服务器名称', normalized_status: '运行中', version: 4 })],
      serverTime: '2026-07-22T10:00:10Z',
    }

    await store.load({ preserveDraft: true, silent: true })

    expect(store.tasks.value[0].task).toBe('每日对账（新版）')
    expect(store.tasks.value[0].normalized_status).toBe('运行中')
    expect(store.mutationList.value[0].version).toBe(3)
  })

  it('保留其他草稿时会清除服务器已移除任务的 saved baseline', async () => {
    let response = {
      tasks: [task(), task({ id: '2', task: '待转交任务', schedule_uuid: 'schedule-2' })],
      serverTime: '2026-07-22T10:00:00Z',
    }
    const store = createTaskDraftStore(async () => response)
    await store.load()
    store.updateTask('1', { note: '保留这项草稿' })
    response = { tasks: [task()], serverTime: '2026-07-22T10:00:10Z' }

    await store.load({ preserveDraft: true, silent: true })
    store.discard()

    expect(store.tasks.value.map(row => row.id)).toEqual(['1'])
  })

  it('新任务使用临时 ID，删除新任务不会留下 mutation', () => {
    const store = createTaskDraftStore(async () => ({ tasks: [], serverTime: null }))
    store._hydrateForTest([])
    const created = store.addTask(task({ id: undefined, version: 0 }))

    expect(created.id.startsWith('tmp:')).toBe(true)
    expect(store.mutationList.value[0]).toMatchObject({
      type: 'create',
      temp_id: created.id,
      schedule_uuid: 'schedule-1',
    })

    store.deleteTask(created.id)
    expect(store.tasks.value).toHaveLength(0)
    expect(store.mutationList.value).toHaveLength(0)
  })

  it('拒绝修改没有 can_edit 权限的任务', () => {
    const store = createTaskDraftStore(async () => ({ tasks: [], serverTime: null }))
    store._hydrateForTest([task({ can_edit: false, is_legacy_unbound: true })])

    expect(store.updateTask('1', { task: '越权修改' })).toBeNull()
    expect(store.deleteTask('1')).toBe(false)
    expect(store.mutationList.value).toHaveLength(0)
  })

  it('reset 会使仍在途中的加载结果失效', async () => {
    const request = deferred()
    const store = createTaskDraftStore(() => request.promise)
    const pending = store.load()

    expect(store.state.loading).toBe(true)
    store.reset()
    request.resolve({ tasks: [task()], serverTime: '2026-07-22T10:00:00Z' })
    await pending

    expect(store.tasks.value).toEqual([])
    expect(store.state.loaded).toBe(false)
    expect(store.state.loading).toBe(false)
  })

  it('reset 会使仍在途中的保存结果失效', async () => {
    const request = deferred()
    const store = createTaskDraftStore(
      async () => ({ tasks: [], serverTime: null }),
      () => request.promise,
    )
    store._hydrateForTest([task()])
    store.updateTask('1', { note: '准备保存' })
    const pending = store.save()

    expect(store.state.saving).toBe(true)
    store.reset()
    request.resolve({ tasks: [task({ note: '准备保存', version: 4 })], id_map: {} })
    const result = await pending

    expect(result.ignored).toBe(true)
    expect(store.tasks.value).toEqual([])
    expect(store.state.loaded).toBe(false)
    expect(store.state.saving).toBe(false)
  })

  it('保存期间跳过定时轮询，并在保存后执行一次刷新', async () => {
    const request = deferred()
    let loaderCalls = 0
    const savedTask = task({ note: '已保存', version: 4 })
    const store = createTaskDraftStore(
      async () => {
        loaderCalls += 1
        return { tasks: [savedTask], serverTime: '2026-07-22T10:00:10Z' }
      },
      () => request.promise,
    )
    store._hydrateForTest([task()])
    store.updateTask('1', { note: '已保存' })
    const saving = store.save()

    await store.load({ preserveDraft: true, silent: true })
    expect(loaderCalls).toBe(0)

    request.resolve({ tasks: [savedTask], id_map: {} })
    await saving
    expect(loaderCalls).toBe(1)
    expect(store.tasks.value[0].note).toBe('已保存')
    expect(store.hasUnsaved.value).toBe(false)
  })

  it('保存期间拒绝丢弃草稿，避免导航后保存响应改写页面状态', async () => {
    const request = deferred()
    const savedTask = task({ note: '正在保存', version: 4 })
    const store = createTaskDraftStore(
      async () => ({ tasks: [savedTask], serverTime: null }),
      () => request.promise,
    )
    store._hydrateForTest([task()])
    store.updateTask('1', { note: '正在保存' })
    const saving = store.save()

    expect(store.discard()).toBe(false)
    expect(store.hasUnsaved.value).toBe(true)

    request.resolve({ tasks: [savedTask], id_map: {} })
    await saving
    expect(store.hasUnsaved.value).toBe(false)
  })

  it('409 冲突后完整保留草稿和 mutation，允许用户处理后重试', async () => {
    const conflict = Object.assign(new Error('任务版本冲突'), {
      status: 409,
      code: 'TASK_VERSION_CONFLICT',
      details: { task_ids: ['1'] },
    })
    const loader = vi.fn(async () => ({ tasks: [task()], serverTime: null }))
    const saver = vi.fn(async () => { throw conflict })
    const store = createTaskDraftStore(loader, saver)
    store._hydrateForTest([task()])
    store.updateTask('1', { note: '冲突时不能丢失', tags: ['财务', '月结'] })
    const draftBeforeSave = JSON.parse(JSON.stringify(store.tasks.value))
    const mutationsBeforeSave = JSON.parse(JSON.stringify(store.mutationList.value))

    await expect(store.save()).rejects.toBe(conflict)

    expect(store.state.saving).toBe(false)
    expect(store.hasUnsaved.value).toBe(true)
    expect(store.tasks.value).toEqual(draftBeforeSave)
    expect(store.mutationList.value).toEqual(mutationsBeforeSave)
    expect(loader).not.toHaveBeenCalled()
  })

  it('保存请求发出后的新编辑会基于服务器新版本继续保留', async () => {
    const request = deferred()
    const serverTask = task({ note: '第一版备注', version: 4 })
    const store = createTaskDraftStore(
      async () => ({ tasks: [serverTask], serverTime: '2026-07-22T10:00:20Z' }),
      () => request.promise,
    )
    store._hydrateForTest([task()])
    store.updateTask('1', { note: '第一版备注' })
    const saving = store.save()

    store.updateTask('1', { task: '保存期间继续编辑' })
    request.resolve({ tasks: [serverTask], id_map: {} })
    await saving

    expect(store.tasks.value[0]).toMatchObject({
      id: '1', version: 4, note: '第一版备注', task: '保存期间继续编辑',
    })
    expect(store.mutationList.value).toEqual([{
      type: 'update',
      id: '1',
      version: 4,
      changes: { task: '保存期间继续编辑' },
    }])
  })

  it('新任务保存期间的后续编辑会在临时 ID 映射后转为 update', async () => {
    const request = deferred()
    let serverTask
    const store = createTaskDraftStore(
      async () => ({ tasks: [serverTask], serverTime: '2026-07-22T10:00:30Z' }),
      () => request.promise,
    )
    store._hydrateForTest([])
    const created = store.addTask(task({ id: undefined, version: 0, note: '创建时备注' }))
    const saving = store.save()

    store.updateTask(created.id, { note: '提交后继续编辑' })
    serverTask = task({ id: '9', version: 1, note: '创建时备注' })
    request.resolve({ tasks: [serverTask], id_map: { [created.id]: '9' } })
    await saving

    expect(store.tasks.value[0]).toMatchObject({ id: '9', version: 1, note: '提交后继续编辑' })
    expect(store.mutationList.value).toEqual([{
      type: 'update',
      id: '9',
      version: 1,
      changes: { note: '提交后继续编辑' },
    }])
  })
})
