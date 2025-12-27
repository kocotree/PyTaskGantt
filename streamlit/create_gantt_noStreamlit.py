import pandas as pd
import plotly.express as px

tasks_data = pd.read_csv("tasks.csv")
df = pd.DataFrame(tasks_data)
df['Start'] = pd.to_datetime(df['Start'], errors='coerce')
df['Finish'] = pd.to_datetime(df['Finish'], errors='coerce')

# 计算任务持续时间
df['Duration'] = ((df['Finish'] - df['Start']).dt.total_seconds() / 60).astype(int)
df['Duration'] = df['Duration'].astype(str) + " min"

# 按机器人名称和开始时间排序
df = df.sort_values(by=["Bot", "Start"], ascending=False)
# 计算有多少个不重复的任务名称，这将决定Y轴有多少行
num_unique_tasks = df['Task'].nunique()
# 设置每个任务行想要的高度（像素）
row_height = 40
# 计算总高度：任务总高度 + 上下边距预留空间(例如150px用于标题、坐标轴标签和图例)
# 同时设置一个最小高度(例如400px)，防止任务太少时图表过矮
total_height = max(400, num_unique_tasks * row_height + 150)

fig = px.timeline(
    df, 
    x_start="Start",
    x_end="Finish",
    y="Task",
    color="Bot",
    title="任务执行甘特图",
    height=total_height,
    text="Duration"
    )

# 更新X轴的格式
fig.update_xaxes(
    title_text='时间',
    tickformat='%H:%M:%S',
    rangeslider_visible = True,
    # 把时间轴放到顶部
    side='top'
)

# 更新Y轴
fig.update_yaxes(
    title_text='任务名称',
    # 锁定Y轴，使其在缩放时不发生变化
    fixedrange=True
)

# 更新图表的整体布局和图例标题
fig.update_layout(
    plot_bgcolor="white",  # 设置背景颜色为白色
    # 网格线
    xaxis=dict(showgrid=True, gridcolor="lightgrey"),
    yaxis=dict(showgrid=True, gridcolor="lightgrey"),
    title_font_size=22,
    font_size=14,
    # 图例标题
    legend_title_text='机器人名称',
    # 增加顶部边距，防止顶部时间轴和标题重叠
    margin=dict(t=100)
)

fig.show()
fig.write_html("Tasks.html")