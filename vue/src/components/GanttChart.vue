<template>
  <div
    class="gantt-chart"
    ref="chartContainer"
    :style="{ height: chartHeight + 'px' }"
  >
    <div
      ref="chartRef"
      class="chart-wrapper"
      :style="{ height: chartHeight + 'px' }"
    ></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, computed } from "vue";
import * as echarts from "echarts";
import { getBotColor, getTimeRange } from "../services/dataService";

const props = defineProps({
  tasks: {
    type: Array,
    required: true,
  },
  onTaskClick: {
    type: Function,
    default: null,
  },
});

const chartRef = ref(null);
const chartContainer = ref(null);
let chart = null;

// 解析时间为分钟数
const timeToMinutes = (timeStr) => {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + minutes;
};

// 格式化分钟为时间字符串
const minutesToTime = (mins) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
};

// 获取所有唯一的机器人用于图例
const uniqueBots = computed(() => {
  return [...new Set(props.tasks.map((t) => t.bot))].sort();
});

// 计算图表高度（基于任务数量）
const chartHeight = computed(() => {
  const taskCount = props.tasks.length;
  // 每个任务约30px高度，最小500px
  return Math.max(500, taskCount * 30 + 150);
});

// 构建 ECharts 配置
const buildChartOption = () => {
  const timeRange = getTimeRange(props.tasks);
  const startMinutes = timeToMinutes(timeRange.start);
  const endMinutes = timeToMinutes(timeRange.end);

  // 按机器人分组的任务
  const tasksByBot = {};
  props.tasks.forEach((task) => {
    if (!tasksByBot[task.bot]) {
      tasksByBot[task.bot] = [];
    }
    tasksByBot[task.bot].push(task);
  });

  // Y轴分类 - 任务名称
  const yAxisData = props.tasks.map((t) => t.task).reverse();

  // 构建系列数据
  const series = uniqueBots.value.map((bot) => {
    const botTasks = props.tasks.filter((t) => t.bot === bot);
    const color = getBotColor(bot);

    const data = botTasks.map((task) => {
      const taskIndex = yAxisData.indexOf(task.task);
      const startMins = timeToMinutes(task.start);
      const endMins = timeToMinutes(task.finish);

      return {
        name: task.task,
        value: [taskIndex, startMins, endMins, task.duration, task.id],
        itemStyle: {
          color: color.main,
          shadowColor: color.glow,
          shadowBlur: 8,
          borderRadius: 4,
        },
        task: task,
      };
    });

    return {
      name: bot,
      type: "custom",
      renderItem: (params, api) => {
        const categoryIndex = api.value(0);
        const start = api.coord([api.value(1), categoryIndex]);
        const end = api.coord([api.value(2), categoryIndex]);
        const height = api.size([0, 1])[1] * 0.75; // 任务条更粗

        return {
          type: "rect",
          shape: {
            x: start[0],
            y: start[1] - height / 2,
            width: end[0] - start[0],
            height: height,
            r: 4,
          },
          style: api.style(),
          emphasis: {
            style: {
              shadowBlur: 20,
              shadowColor: color.glow,
            },
          },
        };
      },
      encode: {
        x: [1, 2],
        y: 0,
      },
      data: data,
      itemStyle: {
        color: color.main,
      },
    };
  });

  return {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      backgroundColor: "rgba(17, 24, 39, 0.95)",
      borderColor: "rgba(139, 92, 246, 0.3)",
      borderWidth: 1,
      textStyle: {
        color: "#f8fafc",
      },
      formatter: (params) => {
        const task = params.data.task;
        if (!task) return "";
        return `
          <div style="padding: 8px;">
            <div style="font-weight: 600; margin-bottom: 8px; color: ${
              getBotColor(task.bot).main
            }">
              ${task.task}
            </div>
            <div style="color: #94a3b8; font-size: 12px;">
              <div>🤖 ${task.bot}</div>
              <div>⏱️ ${task.start} - ${task.finish}</div>
              <div>⏳ 持续: ${task.duration}</div>
            </div>
          </div>
        `;
      },
    },
    legend: {
      data: uniqueBots.value,
      top: 10,
      textStyle: {
        color: "#94a3b8",
      },
      itemStyle: {
        borderWidth: 0,
      },
    },
    grid: {
      left: 180,
      right: 40,
      top: 60,
      bottom: 80,
    },
    xAxis: {
      type: "value",
      min: startMinutes,
      max: endMinutes,
      position: "top",
      axisLabel: {
        color: "#94a3b8",
        formatter: (value) => minutesToTime(value),
      },
      axisLine: {
        lineStyle: {
          color: "rgba(148, 163, 184, 0.2)",
        },
      },
      splitLine: {
        lineStyle: {
          color: "rgba(148, 163, 184, 0.1)",
        },
      },
    },
    yAxis: {
      type: "category",
      data: yAxisData,
      axisLabel: {
        color: "#f8fafc",
        fontSize: 12,
        width: 160,
        overflow: "truncate",
        ellipsis: "...",
      },
      axisLine: {
        lineStyle: {
          color: "rgba(148, 163, 184, 0.2)",
        },
      },
      splitLine: {
        show: false,
      },
    },
    dataZoom: [
      {
        type: "slider",
        xAxisIndex: 0,
        bottom: 20,
        height: 25,
        borderColor: "rgba(139, 92, 246, 0.3)",
        backgroundColor: "rgba(17, 24, 39, 0.8)",
        fillerColor: "rgba(139, 92, 246, 0.2)",
        handleStyle: {
          color: "#8b5cf6",
          borderColor: "#8b5cf6",
        },
        textStyle: {
          color: "#94a3b8",
        },
        // 格式化缩放条两端的时间标签
        labelFormatter: (value) => minutesToTime(Math.round(value)),
        dataBackground: {
          lineStyle: {
            color: "rgba(139, 92, 246, 0.3)",
          },
          areaStyle: {
            color: "rgba(139, 92, 246, 0.1)",
          },
        },
      },
    ],
    series: series,
  };
};

// 初始化图表
const initChart = () => {
  if (!chartRef.value) return;

  chart = echarts.init(chartRef.value, null, {
    renderer: "canvas",
  });

  chart.setOption(buildChartOption());

  // 点击事件
  if (props.onTaskClick) {
    chart.on("click", (params) => {
      if (params.data && params.data.task) {
        props.onTaskClick(params.data.task);
      }
    });
  }
};

// 更新图表
const updateChart = () => {
  if (chart) {
    chart.setOption(buildChartOption(), true);
    // 延迟调用 resize 确保 DOM 更新
    setTimeout(() => {
      chart.resize();
    }, 50);
  }
};

// 响应式调整
const handleResize = () => {
  if (chart) {
    chart.resize();
  }
};

// 监听数据变化
watch(() => props.tasks, updateChart, { deep: true });

// 监听高度变化
watch(chartHeight, () => {
  if (chart) {
    setTimeout(() => {
      chart.resize();
    }, 50);
  }
});

onMounted(() => {
  initChart();
  window.addEventListener("resize", handleResize);
});

onUnmounted(() => {
  window.removeEventListener("resize", handleResize);
  if (chart) {
    chart.dispose();
  }
});
</script>

<style scoped>
.gantt-chart {
  width: 100%;
  min-height: 500px;
  overflow-y: auto;
}

.chart-wrapper {
  width: 100%;
  min-height: 500px;
}
</style>
