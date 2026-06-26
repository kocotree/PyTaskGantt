<template>
  <n-card size="small" :bordered="true">
    <template #header>
      <div>
        <div style="display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600;">
          <span>任务执行甘特图</span>
        </div>
        <div class="gantt-caption">按住 Ctrl + 鼠标滚轮可缩放，拖拽 item 可调整时间</div>
      </div>
    </template>
    <template #header-extra>
      <n-space :size="6">
        <n-button size="tiny" tertiary @click="fitTimeline" title="自适应缩放">
          自适应
        </n-button>
        <n-button size="tiny" tertiary @click="resetTimeline" title="重置视图">
          重置
        </n-button>
      </n-space>
    </template>
    <div ref="containerRef" class="gantt-container"></div>
    <n-empty
      v-if="!tasks.length"
      description="暂无符合条件的任务"
      style="padding: 40px 0;"
    />
    <!-- 拖拽时的浮动 tooltip（teleport 到 body，避免被 card overflow 截断） -->
    <Teleport to="body">
      <div
        v-show="dragTip.visible"
        class="gantt-drag-tip"
        :style="{ left: dragTip.x + 'px', top: dragTip.y + 'px' }"
      >
        <div class="gantt-drag-tip-title">{{ dragTip.task }}</div>
        <div class="gantt-drag-tip-bot">
          <span class="gantt-drag-tip-dot" :style="{ background: dragTip.color }"></span>
          {{ dragTip.bot }}
        </div>
        <div class="gantt-drag-tip-time">
          {{ dragTip.start }} <span class="gantt-drag-tip-arrow">→</span> {{ dragTip.finish }}
          <span v-if="dragTip.duration" class="gantt-drag-tip-duration">{{ dragTip.duration }}</span>
          <span v-if="dragTip.crossDay" class="gantt-drag-tip-cross">次日</span>
        </div>
      </div>
    </Teleport>
    <!-- 动态注入每个机器人的颜色 class -->
    <component :is="'style'" v-html="dynamicStyles" />
  </n-card>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { Timeline } from 'vis-timeline/standalone'
import { DataSet } from 'vis-data'
import { NCard, NSpace, NButton, NEmpty } from 'naive-ui'
import {
  parseTimeToDate,
  getBotColor,
  DUMMY_DATE,
  isCrossDay,
  formatDuration,
} from '../services/dataService.js'

const props = defineProps({
  tasks: { type: Array, required: true },
})

const emit = defineEmits(['task-click', 'task-update'])

const containerRef = ref(null)
let timeline = null
let itemsDataset = null
let groupsDataset = null
// 拖拽自身触发的 task-update 会导致父组件 allTasks 变化 → 触发本组件 watch。
// 我们已在 onMove 里同步了 dataset，无需再 updateData，这里用一次性标志位跳过。
let suppressNextUpdate = false
// vis-timeline 拖拽 mouseup 后还会触发一次 click，这里用 justDragged 时间窗抑制误弹编辑器
let justDragged = false
// 拖拽中标志：拖拽时由 onMoving 控制 tooltip，hover 事件不能干扰
let isDragging = false

// 自渲染 tooltip 状态（统一用于 hover 与拖拽，浏览器原生 title 已禁用）
const dragTip = ref({
  visible: false,
  x: 0,
  y: 0,
  task: '',
  bot: '',
  color: '#1677ff',
  start: '',
  finish: '',
  duration: '',
  crossDay: false,
})

// 最近鼠标坐标（拖拽边缘自动滚动用）
let lastClientX = 0
let lastClientY = 0

// 鼠标移动始终更新坐标（即使 visible=false 也更新，避免显示瞬间 tooltip 出现在 (0,0)）
// 关键：用 pointermove + capture phase 监听
// 原因：vis-timeline 内部的 hammer.js 拖拽时会对元素 setPointerCapture，
// 此时浏览器只继续派发 pointer events，兼容性的 mousemove 可能被吞掉，
// 所以必须监听 pointermove 才能在拖拽中持续拿到光标坐标。
function onWindowMouseMove(e) {
  lastClientX = e.clientX
  lastClientY = e.clientY
  // 偏移 14/18px 避免遮住光标和被光标 hover 拦截
  dragTip.value.x = e.clientX + 14
  dragTip.value.y = e.clientY + 18
}

// ===== 拖拽到边缘自动平移视窗 =====
let autoScrollRaf = null
// 当前正在拖拽的 item id（用于 tickAutoScroll 同步推任务条）
let draggingItemId = null

// 把视窗平移 move ms 时，同步推进 vis-timeline 内部的「拖拽基线时间」。
// vis 内部计算公式：itemData.start = touchParams.itemProps[i].data.start + (toTime(光标X) - toTime(initialX))。
// 因为 toTime 用当前 window，两次 toTime 都加上相同 move，offset 对窗口平移不敏感。
// 不推进基线的话，光标只要轻微抖动 vis 就会用旧基线把任务条写回旧时间，造成「向反方向瞬移」。
function advanceDragBaseline(move) {
  const itemSet = timeline && timeline.itemSet
  const props = itemSet && itemSet.touchParams && itemSet.touchParams.itemProps
  if (!props) return
  for (const p of props) {
    if (!p || !p.data) continue
    if (p.data.start != null) {
      const s = p.data.start instanceof Date ? p.data.start : new Date(p.data.start)
      p.data.start = new Date(s.getTime() + move)
    }
    if (p.data.end != null) {
      const e = p.data.end instanceof Date ? p.data.end : new Date(p.data.end)
      p.data.end = new Date(e.getTime() + move)
    }
  }
}

function tickAutoScroll() {
  if (!isDragging || !timeline || !containerRef.value) {
    autoScrollRaf = null
    return
  }
  const rect = containerRef.value.getBoundingClientRect()
  const EDGE = 150 // 触发自动滚动的边缘距离 (px) —— 提前预估，光标还没贴边就开始
  const distLeft = lastClientX - rect.left
  const distRight = rect.right - lastClientX

  let dir = 0
  if (distLeft < EDGE) {
    dir = -(EDGE - distLeft) / EDGE // -1..0，越靠左越快
  } else if (distRight < EDGE) {
    dir = (EDGE - distRight) / EDGE // 0..1，越靠右越快
  }

  if (dir !== 0) {
    const win = timeline.getWindow()
    const range = win.end.getTime() - win.start.getTime()
    const move = range * 0.018 * dir // 每帧移动当前可视范围的 ~1.8% × 强度

    // ★ 三步顺序：①推进 vis 内部拖拽基线 ②同步 dataset（停止抖动时也跟随窗口）③平移视窗
    // 顺序反了的话 setWindow 会先 redraw 旧时间的任务条，视觉上出现反向瞬移。
    advanceDragBaseline(move)
    if (draggingItemId != null && itemsDataset) {
      // 关键：必须从 timeline.itemSet.items[id].data 读「拖拽位移后的实时位置」，
      // 不能用 itemsDataset.get() —— dataset 在拖拽期间一直保持原始时间，
      // 用 dataset 的旧值 + move 写回时，vis 的 _updateItem→setData 会把已拖拽的位移擦掉。
      // 表现：左抓时拖拽位移很大，瞬移就很明显；右抓时位移小，几乎察觉不到。
      const liveItem = timeline.itemSet && timeline.itemSet.items[draggingItemId]
      if (liveItem && liveItem.data && liveItem.data.start) {
        const ls = liveItem.data.start instanceof Date ? liveItem.data.start : new Date(liveItem.data.start)
        const le = liveItem.data.end
          ? (liveItem.data.end instanceof Date ? liveItem.data.end : new Date(liveItem.data.end))
          : null
        const newStart = new Date(ls.getTime() + move)
        const newEnd = le ? new Date(le.getTime() + move) : null
        itemsDataset.update({ id: draggingItemId, start: newStart, end: newEnd })
        // _raw 仍从 dataset 取（dataset 上挂着原始 task 对象）
        const dsEntry = itemsDataset.get(draggingItemId)
        if (dsEntry && dsEntry._raw) {
          showTipFromTask(
            dsEntry._raw,
            formatTime(newStart),
            formatTime(newEnd || newStart)
          )
        }
      }
    }

    timeline.setWindow(
      win.start.getTime() + move,
      win.end.getTime() + move,
      { animation: false }
    )
  }
  autoScrollRaf = requestAnimationFrame(tickAutoScroll)
}

function startAutoScroll() {
  if (autoScrollRaf == null) {
    autoScrollRaf = requestAnimationFrame(tickAutoScroll)
  }
}

function stopAutoScroll() {
  if (autoScrollRaf != null) {
    cancelAnimationFrame(autoScrollRaf)
    autoScrollRaf = null
  }
}

function showTipFromTask(task, startStr, finishStr) {
  dragTip.value.task = task.task
  dragTip.value.bot = task.bot
  dragTip.value.color = getBotColor(task.bot)
  dragTip.value.start = startStr
  dragTip.value.finish = finishStr
  dragTip.value.duration = formatDuration(startStr, finishStr)
  dragTip.value.crossDay = isCrossDay(startStr, finishStr)
  dragTip.value.visible = true
}

function hideTip() {
  dragTip.value.visible = false
}

// 把 bot 名称转为合法的 CSS class 名（处理中文）
function botClassName(bot) {
  // 用 base64 (URL-safe) 保证唯一性 + 合法字符
  const safe = encodeURIComponent(bot).replace(/[^a-zA-Z0-9]/g, '_')
  return `bot-${safe}`
}

const uniqueBots = computed(() => {
  return [...new Set(props.tasks.map(t => t.bot))]
})

// 动态生成每个 bot 的颜色 CSS
const dynamicStyles = computed(() => {
  return uniqueBots.value
    .map(bot => {
      const color = getBotColor(bot)
      const cls = botClassName(bot)
      return `
.vis-item.${cls} {
  background-color: ${color};
  border-color: ${color};
  color: #ffffff;
}
.vis-item.${cls}.vis-selected {
  background-color: ${color};
  border-color: ${color};
}
`
    })
    .join('\n')
})

// 任务 → vis-timeline items（每个任务独占一行，group 用 task.id）
// 注意：不再写 title 字段，统一用自渲染 tooltip 显示，避免浏览器原生 tooltip 干扰
function buildItems(tasks) {
  return tasks.map(t => {
    const { start, end } = parseTimeToDate(t.start, t.finish)
    return {
      id: t.id,
      group: t.id, // 每个任务独占一个 group → 一行
      content: '', // 任务条上不显示文字；时长改在 hover tooltip 显示
      start,
      end,
      className: botClassName(t.bot),
      _raw: t,
    }
  })
}

// 任务 → vis-timeline groups（每个任务一行，label 显示任务名 + 机器人色块）
// 行序直接沿用父组件传入的 tasks 顺序——排序的唯一事实源是 App.vue 的 filterTasks(sortBy)。
// 不在这里二次排序，否则「按时间 / 按机器人」切换对甘特图不生效。
function buildGroups(tasks) {
  return tasks.map((t, idx) => ({
    id: t.id,
    order: idx, // 配合 timeline option `groupOrder: 'order'` 控制行序
    // 左侧轨道标签：色块 + 任务名 + 机器人名
    content: `
      <div style="display:flex; align-items:center; gap:6px; padding-right:8px;">
        <span style="display:inline-block; width:10px; height:10px; border-radius:2px; background:${getBotColor(t.bot)}; flex-shrink:0;"></span>
        <span style="font-size:12px; font-weight:500; color:rgba(0,0,0,0.88); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${t.task} · ${t.bot}">${t.task}</span>
      </div>
    `,
    className: botClassName(t.bot),
    _bot: t.bot,
    _start: t.start,
  }))
}

function createTimeline() {
  if (!containerRef.value) return

  itemsDataset = new DataSet(buildItems(props.tasks))
  groupsDataset = new DataSet(buildGroups(props.tasks))

  const options = {
    stack: false,
    editable: {
      add: false,
      updateTime: true,
      updateGroup: false,
      remove: false,
      overrideItems: false,
    },
    zoomable: true,
    moveable: true,
    orientation: 'top',
    showCurrentTime: false,
    margin: { item: { vertical: 4, horizontal: 0 }, axis: 8 },
    verticalScroll: true,
    zoomKey: 'ctrlKey', // 防止误缩放，按住 Ctrl 才能滚轮缩放
    maxHeight: '560px',
    minHeight: '320px',
    groupHeightMode: 'fixed',
    groupOrder: 'order',
    min: new Date(`${DUMMY_DATE}T00:00:00`),
    max: new Date(`${DUMMY_DATE}T23:59:59`),
    start: new Date(`${DUMMY_DATE}T08:30:00`),
    end: new Date(`${DUMMY_DATE}T13:00:00`),
    zoomMin: 1000 * 60 * 5, // 5 分钟
    zoomMax: 1000 * 60 * 60 * 30, // 30 小时
    format: {
      minorLabels: { minute: 'HH:mm', hour: 'HH:mm' },
      majorLabels: { hour: '', day: '' },
    },
    onMoving: (item, callback) => {
      // 拖拽过程中实时刷新自渲染 tooltip
      const raw = item._raw
      if (raw) {
        if (!isDragging) {
          isDragging = true
          draggingItemId = item.id
          startAutoScroll() // 开始边缘自动滚动监测
        }
        // 注意：自动滚动产生的视窗平移已经通过 advanceDragBaseline 写回到 vis 内部基线，
        // 所以这里收到的 item.start/end 已经是含「视窗平移 + 光标 delta」的最终值，无需补偿。
        const newStart = formatTime(item.start)
        const newFinish = formatTime(item.end || new Date(item.start.getTime() + 30 * 60 * 1000))
        showTipFromTask(raw, newStart, newFinish)
      }
      callback(item)
    },
    onMove: (item, callback) => {
      // 拖拽完成回调：vis-timeline 内部已经把新位置（含视窗平移）写到了 dataset 里。
      // 我们 emit 通知父组件更新数据源，但要抑制父组件回流引发的整体重建。
      const newStart = formatTime(item.start)
      const newFinish = formatTime(item.end || new Date(item.start.getTime() + 30 * 60 * 1000))
      callback(item)
      // 隐藏 tooltip + 清拖拽态 + 停掉自动滚动 + 清拖拽 id
      isDragging = false
      draggingItemId = null
      stopAutoScroll()
      hideTip()
      suppressNextUpdate = true
      // 抑制 mouseup 后紧跟的 click 事件，避免拖完就弹编辑器
      justDragged = true
      setTimeout(() => { justDragged = false }, 250)
      emit('task-update', {
        id: item.id,
        start: newStart,
        finish: newFinish,
      })
    },
  }

  timeline = new Timeline(containerRef.value, itemsDataset, groupsDataset, options)

  // 单击：触发编辑
  timeline.on('click', props_evt => {
    if (justDragged) return // 刚结束拖拽的 click 是误触，不弹编辑器
    if (props_evt.item != null && props_evt.what === 'item') {
      const item = itemsDataset.get(props_evt.item)
      if (item && item._raw) {
        // _raw 是 buildItems 时的原始引用，时间可能已被拖拽更新过；
        // 这里从 dataset 拿到最新 start/end 重新组装，避免回填旧时间。
        const latest = {
          ...item._raw,
          start: formatTime(item.start),
          finish: formatTime(item.end || item.start),
        }
        emit('task-click', latest)
      }
    }
  })

  // Hover：进入 item 显示 tooltip
  timeline.on('itemover', evt => {
    if (isDragging) return // 拖拽中由 onMoving 控制，不要被 hover 抢
    if (evt.item == null) return
    const item = itemsDataset.get(evt.item)
    if (!item || !item._raw) return
    showTipFromTask(
      item._raw,
      formatTime(item.start),
      formatTime(item.end || item.start)
    )
  })

  // Hover：离开 item 隐藏（拖拽中可能短暂离开 item 区域，此时不要隐藏）
  timeline.on('itemout', () => {
    if (isDragging) return
    hideTip()
  })
}

function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

// 差异化同步 dataset：
// - 删除新数据里没有的 id
// - update 已存在的 id（属性变了会触发重绘，没变就保留）
// - 新增的 id 由 update 自动追加
// 避免 clear()+add() 整体重建造成的闪烁。
function syncDataset(dataset, nextRows) {
  const oldIds = dataset.getIds()
  const nextIds = new Set(nextRows.map(r => r.id))
  const toRemove = oldIds.filter(id => !nextIds.has(id))
  if (toRemove.length) dataset.remove(toRemove)
  dataset.update(nextRows)
}

function updateData() {
  if (!timeline || !itemsDataset || !groupsDataset) return
  syncDataset(groupsDataset, buildGroups(props.tasks))
  syncDataset(itemsDataset, buildItems(props.tasks))
}

function fitTimeline() {
  timeline?.fit({ animation: { duration: 300 } })
}

function resetTimeline() {
  if (!timeline) return
  timeline.setWindow(
    new Date(`${DUMMY_DATE}T08:30:00`),
    new Date(`${DUMMY_DATE}T13:00:00`),
    { animation: { duration: 300 } }
  )
}

watch(
  () => props.tasks,
  async () => {
    await nextTick()
    if (!timeline) {
      createTimeline()
      return
    }
    // 拖拽自身触发的数据回流：vis 已经显示了新位置，跳过一次同步避免重排闪烁
    if (suppressNextUpdate) {
      suppressNextUpdate = false
      return
    }
    updateData()
  },
  { deep: true }
)

onMounted(() => {
  createTimeline()
  // pointermove 是关键：拖拽中 hammer.js 会 setPointerCapture，mousemove 被吞，但 pointermove 仍会派发
  // capture: true —— 在 vis-timeline 内部之前先收到事件
  window.addEventListener('pointermove', onWindowMouseMove, { passive: true, capture: true })
  // mousemove 作为非拖拽态的兜底（hover 移动时 pointermove 也会触发，但保留 mousemove 不会有坏处）
  window.addEventListener('mousemove', onWindowMouseMove, { passive: true, capture: true })
  // 拖拽过程中如果 pointerup/mouseup 在 timeline 外或被打断，兜底隐藏 tooltip
  window.addEventListener('pointerup', hideDragTip, { capture: true })
  window.addEventListener('mouseup', hideDragTip, { capture: true })
  window.addEventListener('blur', hideDragTip)
})

function hideDragTip() {
  // 拖拽中（isDragging=true）的 mouseup 由 onMove 处理；非拖拽态的 mouseup/blur 兜底隐藏
  if (!isDragging && dragTip.value.visible) dragTip.value.visible = false
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onWindowMouseMove, { capture: true })
  window.removeEventListener('mousemove', onWindowMouseMove, { capture: true })
  window.removeEventListener('pointerup', hideDragTip, { capture: true })
  window.removeEventListener('mouseup', hideDragTip, { capture: true })
  window.removeEventListener('blur', hideDragTip)
  stopAutoScroll()
  if (timeline) {
    timeline.destroy()
    timeline = null
  }
})
</script>

<style scoped>
.gantt-container {
  width: 100%;
  min-height: 320px;
}
</style>

<style>
/* 自渲染拖拽 tooltip —— teleport 到 body，不能用 scoped */
.gantt-drag-tip {
  position: fixed;
  z-index: 9999;
  pointer-events: none;
  min-width: 160px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.86);
  color: #ffffff;
  border-radius: 6px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
  font-size: 12px;
  line-height: 1.6;
  font-variant-numeric: tabular-nums;
  backdrop-filter: blur(4px);
}
.gantt-drag-tip-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 2px;
  color: #ffffff;
}
.gantt-drag-tip-bot {
  display: flex;
  align-items: center;
  gap: 6px;
  color: rgba(255, 255, 255, 0.75);
  font-size: 11px;
}
.gantt-drag-tip-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.gantt-drag-tip-time {
  margin-top: 4px;
  font-family: "SF Mono", "Fira Code", Consolas, monospace;
  font-size: 12px;
  color: #ffffff;
}
.gantt-drag-tip-arrow {
  margin: 0 2px;
  color: rgba(255, 255, 255, 0.6);
}
.gantt-drag-tip-cross {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  background: #fa8c16;
  color: #ffffff;
  border-radius: 3px;
  font-size: 10px;
  font-family: inherit;
}
.gantt-drag-tip-duration {
  display: inline-block;
  margin-left: 8px;
  padding: 0 6px;
  background: rgba(255, 255, 255, 0.18);
  color: rgba(255, 255, 255, 0.92);
  border-radius: 3px;
  font-size: 11px;
  font-family: inherit;
  font-weight: 500;
}
</style>

<style>
/* 全局样式：限制 vis-timeline 左侧轨道标签宽度 */
.vis-labelset .vis-label {
  width: 220px;
  min-width: 220px;
  max-width: 260px;
  padding: 0;
}
.vis-labelset .vis-label .vis-inner {
  padding: 4px 0;
  width: 100%;
  overflow: hidden;
}
.vis-timeline .vis-panel.vis-left {
  border-right: 1px solid #f0f0f0;
}
/* 行高紧凑一些 */
.vis-foreground .vis-group {
  border-bottom: 1px solid #fafafa;
}
/* 任务条垂直居中：
   stack:false 时 vis 把每个任务条钉在 top = margin.item.vertical(4px)，而行高(31px)由更高的
   左侧标签撑起，导致任务条偏上、底部留白(4px/7px)。
   item 的 top 相对其所属 .vis-group 容器（高度=行高），用 50% 取行中线，再减去任务条自身高度的一半
   (固定 20px → 10px) 上移回正，实现与网格行居中。!important 覆盖 vis 写入的内联 top。
   （不用 translateY(-50%)：vis-item 上的 transform 会被内部样式覆盖而失效。） */
.vis-foreground .vis-item.vis-range {
  top: calc(50% - 10px) !important;
}
</style>
