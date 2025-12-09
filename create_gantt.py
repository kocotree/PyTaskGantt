import pandas as pd
import plotly.express as px
import streamlit as st
from datetime import datetime

# --- 页面基础设置 ---
st.set_page_config(page_title="任务甘特图", layout="wide")

st.title("自动化任务图 - 交互式编辑器")

# --- 数据文件路径 ---
file_path = "ShadowBot_tasks.csv"

# --- 常量定义 ---
# 用于标准化的虚拟日期，确保所有时间都在同一天比较
DUMMY_DATE = "2025-01-01"

# --- 数据处理函数 ---


@st.cache_data
def load_data(file_path):
    """
    加载数据并标准化时间。
    无论CSV中是否包含日期，都统一转换为 DUMMY_DATE + 时间。
    """
    try:
        df = pd.read_csv(file_path)

        # 确保必要的列存在
        required_columns = ["Task", "Start", "Finish", "Bot"]
        if not all(col in df.columns for col in required_columns):
            st.error(f"CSV文件缺少必要的列: {required_columns}")
            return pd.DataFrame(columns=required_columns)

        # 转换时间列
        # 1. 先尝试转为 datetime
        # 2. 提取 time 部分
        # 3. 拼接 DUMMY_DATE 形成完整的 datetime 对象用于计算和绘图
        for col in ["Start", "Finish"]:
            # 强制转换为 datetime，处理可能的格式错误
            temp_dt = pd.to_datetime(df[col], errors="coerce")

            # 如果转换后有空值（NaT），填充一个默认时间以免报错（可选）
            # 这里选择不填充，保留NaT以便后续dropna处理

            # 标准化：取出时间部分，拼接到固定的日期上
            # 这样做的目的是忽略原始数据中的日期差异，只比较时间
            df[col] = pd.to_datetime(
                f"{DUMMY_DATE} " + temp_dt.dt.strftime("%H:%M:%S"), errors="coerce"
            )

        return df
    except FileNotFoundError:
        st.error(f"错误：找不到数据文件 '{file_path}'。请确保文件存在。")
        return None
    except Exception as e:
        st.error(f"读取数据时发生错误: {e}")
        return None


def save_data(full_df, file_path):
    """
    保存数据到CSV。
    关键步骤：剥离日期，只保存 HH:MM:SS 格式。
    """
    try:
        df_to_save = full_df.copy()
        # 格式化时间列，只保留时分秒
        df_to_save["Start"] = df_to_save["Start"].dt.strftime("%H:%M:%S")
        df_to_save["Finish"] = df_to_save["Finish"].dt.strftime("%H:%M:%S")

        df_to_save.to_csv(file_path, index=False)
        return True
    except Exception as e:
        return str(e)


# --- 主逻辑 ---

# 1. 加载全量数据
# 注意：我们不直接修改 st.session_state 中的数据，而是每次重新加载
# 为了支持保存功能，我们需要区分 "原始全量数据" 和 "当前视图数据"
if "data_needs_reload" not in st.session_state:
    st.session_state.data_needs_reload = False

if st.session_state.data_needs_reload:
    st.cache_data.clear()
    st.session_state.data_needs_reload = False

df_original = load_data(file_path)

if df_original is not None:

    # --- 布局拆分 ---
    # 左侧 (80%)：编辑器
    # 右侧 (20%)：筛选与操作面板
    col_editor, col_filter = st.columns([0.8, 0.2])

    # 1. 先定义筛选控件的变量 (但暂不渲染布局，为了代码逻辑清晰，先初始化变量)
    # 或者，我们利用 Streamlit 的 "with column" 特性，可以先渲染 editor，再渲染 filter

    # --- 编辑器区域 (左侧) ---
    # 我们先渲染编辑器，这样我们就能拿到 edited_df
    # 注意：为了让筛选生效，我们需要先计算出 df_filtered。
    # 所以逻辑顺序是：
    # 1. 在 col_filter 渲染筛选控件 -> 得到筛选条件
    # 2. 计算 df_filtered
    # 3. 在 col_editor 渲染编辑器 -> 得到 edited_df
    # 4. 在 col_filter 渲染 "保存按钮" (追加在筛选控件下方) -> 使用 edited_df 执行保存

    # 为了实现上述 "在 col_filter 分两步渲染" (筛选控件在上，保存按钮在下)，
    # 我们可以直接按顺序写。Streamlit 允许即使切出去了再切回来写。

    # --- 第一步：渲染筛选控件 (右侧) ---
    with col_filter:
        st.subheader("🔍 筛选与操作")

        # A. 任务搜索
        search_term = st.text_input("搜索任务名称", placeholder="输入关键词...")

        # B. 机器人过滤
        all_bots = sorted(df_original["Bot"].dropna().unique().tolist())
        selected_bots = st.multiselect("筛选机器人", all_bots, default=all_bots)

        st.divider()  # 分割线

    # --- 第二步：计算筛选结果 ---
    df_filtered = df_original.copy()
    if selected_bots:
        df_filtered = df_filtered[df_filtered["Bot"].isin(selected_bots)]
    else:
        df_filtered = df_filtered[df_filtered["Bot"].isin([])]

    if search_term:
        df_filtered = df_filtered[
            df_filtered["Task"].str.contains(search_term, case=False, na=False)
        ]

    # --- 第三步：渲染编辑器 (左侧) ---
    with col_editor:
        st.subheader("任务数据编辑")
        edited_df = st.data_editor(
            df_filtered,
            num_rows="dynamic",
            column_config={
                "Start": st.column_config.TimeColumn("开始时间", format="HH:mm:ss"),
                "Finish": st.column_config.TimeColumn("结束时间", format="HH:mm:ss"),
                "Bot": st.column_config.SelectboxColumn(
                    "机器人", options=all_bots, required=True
                ),
            },
            use_container_width=True,
            key="editor",
        )

        # --- 标准化日期 ---
        # 用户编辑时间时，Streamlit 可能会将日期重置为"今天"或返回time对象。
        # 这里强制将所有数据的日期部分重置为 DUMMY_DATE，防止时间轴跨度异常。
        try:
            for col in ["Start", "Finish"]:
                # 提取时间部分字符串（适配 datetime, time, str 等类型）并重新拼接 DUMMY_DATE
                edited_df[col] = edited_df[col].apply(
                    lambda x: pd.to_datetime(
                        f"{DUMMY_DATE} {str(x).split(' ')[-1]}", errors="coerce"
                    )
                )
        except Exception as e:
            st.warning(f"自动修复日期格式时遇到轻微问题，可能影响显示: {e}")

    # --- 第四步：渲染保存按钮 (回到右侧) ---
    with col_filter:
        st.caption(f"当前显示: {len(df_filtered)} / 总数: {len(df_original)}")

        # 保存按钮逻辑
        if st.button("💾 保存更改", type="primary", use_container_width=True):
            # 1. 识别被删除的行
            original_filtered_indices = set(df_filtered.index)
            current_edited_indices = set(edited_df.index)

            deleted_indices = original_filtered_indices - current_edited_indices

            # 2. 准备新的全量数据
            new_full_df = df_original.copy()

            # A. 执行删除
            if deleted_indices:
                new_full_df = new_full_df.drop(index=list(deleted_indices))

            # B. 执行更新和追加
            remaining_indices_to_overwrite = original_filtered_indices - deleted_indices
            new_full_df = new_full_df.drop(index=list(remaining_indices_to_overwrite))
            new_full_df = pd.concat([new_full_df, edited_df])

            # 3. 排序
            new_full_df = new_full_df.sort_values(by=["Bot", "Start"])

            # 执行保存
            result = save_data(new_full_df, file_path)
            if result is True:
                st.success("✅ 保存成功！")
                st.session_state.data_needs_reload = True
                # 稍微延迟后重载，或者直接依赖下一次交互
                # st.rerun() 通常需要放在最后，这里直接rerun即可
                st.rerun()
            else:
                st.error(f"❌ 保存失败: {result}")

    # --- 可视化区域 ---
    st.divider()

    # 绘图使用 edited_df
    plot_df = edited_df.copy()
    plot_df.dropna(subset=["Start", "Finish"], inplace=True)

    if not plot_df.empty:
        # 计算持续时间
        plot_df["Duration_seconds"] = (
            plot_df["Finish"] - plot_df["Start"]
        ).dt.total_seconds()
        plot_df["Duration"] = (plot_df["Duration_seconds"] / 60).round().astype(
            int
        ).astype(str) + " min"

        plot_df = plot_df.sort_values(by=["Bot", "Start"], ascending=False)

        # 修复：使用唯一任务数来计算高度
        num_tasks = plot_df["Task"].nunique()
        row_height = 55

        # 修正高度计算公式：
        # 之前预留的 150px 不足以容纳 标题 + 顶部时间轴 + 底部 Range Slider + 图例
        # Range Slider 会占用约 60-80px，导致绘图区被压缩，任务条与Y轴文字对不齐
        # 将预留空间增加到 280px
        total_height = max(600, num_tasks * row_height + 280)

        # --- 计算动态时间范围 ---
        # 获取最早开始时间和最晚结束时间
        min_start = plot_df["Start"].min()
        max_finish = plot_df["Finish"].max()

        # 添加 15 分钟的缓冲，避免任务条紧贴图表边缘
        buffer_time = pd.Timedelta(minutes=15)
        view_start = min_start - buffer_time
        view_end = max_finish + buffer_time

        fig = px.timeline(
            plot_df,
            x_start="Start",
            x_end="Finish",
            y="Task",
            color="Bot",
            title="任务执行甘特图 (24小时视图)",
            height=total_height,
            text="Duration",
        )

        # 增加任务条上文本的字体大小，并调整条的宽度
        fig.update_traces(textfont_size=16, width=0.7)

        fig.update_xaxes(
            title_text="时间",
            tickformat="%H:%M",
            side="top",
            # 优化：默认视图范围设为所有任务的实际跨度（加缓冲）
            # 用户仍可通过滑块缩放查看全天或其他范围
            range=[view_start, view_end],
            rangeslider_visible=True,
            rangeslider_thickness=0.05,
        )

        # 强制 Y 轴顺序与 DataFrame 中的排序一致 (Bot 排序 -> Start 排序)
        # 这确保了图表视觉上的整洁
        fig.update_yaxes(
            title_text="任务",
            fixedrange=True,
            tickfont=dict(size=14),
            categoryorder="array",
            categoryarray=plot_df["Task"].unique()[
                ::-1
            ],  # 反转以配合 Plotly 从下往上的绘制顺序
        )

        fig.update_layout(
            plot_bgcolor="white",
            xaxis=dict(showgrid=True, gridcolor="#eee"),
            yaxis=dict(showgrid=True, gridcolor="#eee"),
            margin=dict(t=100),
            legend_title_text="机器人",
        )

        st.plotly_chart(fig, use_container_width=True)
    else:
        st.info("暂无符合条件的任务数据，请调整筛选条件或添加新任务。")

else:
    st.stop()
