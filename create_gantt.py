import pandas as pd
import plotly.express as px
import streamlit as st

# --- 页面基础设置 ---
st.set_page_config(page_title="任务甘特图", layout="wide")

st.title("自动化任务图 - 交互式编辑器")

# --- 数据加载 ---
# 将数据加载封装成一个函数，并使用 Streamlit 的缓存机制
# 这样每次操作时，如果文件没变，就不会重复读取，提高效率
@st.cache_data
def load_data(file_path="tasks.csv"):
    try:
        df = pd.read_csv(file_path)
        df['Start'] = pd.to_datetime(df['Start'], errors='coerce')
        df['Finish'] = pd.to_datetime(df['Finish'], errors='coerce')
        return df
    except FileNotFoundError:
        st.error(f"错误：找不到数据文件 '{file_path}'。请确保文件存在。")
        return None

# 加载数据
df_original = load_data()

if df_original is not None:
    st.info("你可以直接在下方的表格中编辑任务信息，图表将会实时更新。编辑完成后，点击'保存更改'按钮即可将修改写入原始CSV文件。")

    # --- 可编辑的数据表格 ---
    # st.data_editor 是Streamlit的核心功能，它会显示一个像Excel一样的表格
    # 用户可以直接在网页上修改这个表格，所有修改会实时保存在 edited_df 中
    edited_df = st.data_editor(
        df_original,
        num_rows="dynamic",  # 允许用户添加和删除行
        column_config={      # (可选) 配置列的显示方式
            "Start": st.column_config.DatetimeColumn("开始时间", format="HH:mm:ss"),
            "Finish": st.column_config.DatetimeColumn("结束时间", format="HH:mm:ss"),
        }
    )

    # --- 保存按钮 ---
    if st.sidebar.button("保存更改到 tasks.csv"):
        try:
            # 将编辑后的数据框保存回CSV文件，index=False表示不保存行号
            edited_df.to_csv("tasks.csv", index=False)
            st.sidebar.success("更改已成功保存！")
            # 清除缓存，以便下次重新加载最新数据
            st.cache_data.clear()
        except Exception as e:
            st.sidebar.error(f"保存失败: {e}")

    # --- 使用编辑后的数据进行可视化 ---
    # 后续的所有计算和绘图都使用 edited_df
    df = edited_df.copy() # 创建副本以防万一

    # 过滤掉无效的时间行
    df.dropna(subset=['Start', 'Finish'], inplace=True)
    
    # 计算任务持续时间
    df['Duration_seconds'] = (df['Finish'] - df['Start']).dt.total_seconds()
    df['Duration'] = (df['Duration_seconds'] / 60).round().astype(int).astype(str) + " min"

    # 按机器人名称和开始时间排序
    df = df.sort_values(by=["Bot", "Start"], ascending=False)
    
    # 动态计算图表高度
    if not df.empty:
        # 计算有多少个不重复的任务名称，这将决定Y轴有多少行
        num_unique_tasks = df['Task'].nunique()
        # 设置每个任务行想要的高度（像素）
        row_height = 40
        # 计算总高度：任务总高度 + 上下边距预留空间(例如150px用于标题、坐标轴标签和图例)
        # 同时设置一个最小高度(例如400px)，防止任务太少时图表过矮
        total_height = max(500, num_unique_tasks * row_height + 150)

        # --- 绘制图表 ---
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
        
        fig.update_xaxes(
            title_text='时间',
            tickformat='%H:%M:%S',
            rangeslider_visible=True,
            # 把时间轴放到顶部
            side='top'
            )
        
        fig.update_yaxes(
            title_text='任务名称',
            # 锁定Y轴，使其在缩放时不发生变化
            fixedrange=True
            )
        
        fig.update_layout(
            plot_bgcolor="white",
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

        # 使用 st.plotly_chart 在Streamlit应用中显示图表
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.warning("没有有效的任务数据可供显示。请检查表格中的时间和日期。")