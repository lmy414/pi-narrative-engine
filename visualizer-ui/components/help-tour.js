/* help-tour.js — 帮助弹窗（新手操作指南） */
(function () {
  "use strict";
  window.V3.components.HelpTour = {
    name: "HelpTour",
    props: {
      modelValue: { type: Boolean, default: false }
    },
    emits: ["update:modelValue"],
    template: `
      <el-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)"
                 title="新手操作指南" width="560px">
        <div class="help-body">
          <h4>整体玩法</h4>
          <ul>
            <li>顶部<b>故事时间轴</b>：点击刻度，整个工作台切换到「那一刻的世界」；刻度下的小字是该时刻的事件数</li>
            <li>左栏<b>找实体</b>：搜索、按类型筛选、开关「含已消亡」；点「+ 新建实体」创建新实体</li>
            <li>中栏<b>看结构</b>：邻域图（选中实体的一度关系）/ 全景图（整个世界）/ 快照表（全部属性明细）三个视图切换</li>
            <li>右栏<b>改数据</b>：基本信息、属性、关系、可见性、历史五个分区，保存即生效</li>
            <li>所有编辑都以「当前选中时刻」为故事时间写入，不会改写历史</li>
          </ul>
          <h4>3D 图操作</h4>
          <ul>
            <li>左键拖拽：旋转；右键拖拽：平移；滚轮：缩放</li>
            <li>悬停节点看摘要；点击节点在右栏打开编辑；连线悬停看关系名</li>
            <li>节点颜色＝实体类型（蓝角色 / 绿地点 / 橙物品 / 紫概念）；红色＝当前选中；灰色＝角色视角下不可见或已消亡</li>
          </ul>
          <h4>属性编辑（右栏核心）</h4>
          <ul>
            <li>直接改值 / 改模态（事实·信念·推测）/ 点「删除」标记删除，底部可「+ 添加属性」</li>
            <li>点「保存修改」统一提交：每次保存生成一条 change 事件，旧值不会丢失，可在「历史」区查看</li>
            <li>值会自动识别数字和 true / false</li>
          </ul>
          <h4>关系与可见性</h4>
          <ul>
            <li>「+ 新建关系」：选对端实体、填关系名（如 师徒 / located_in）即可；「闭合」让关系从当前时刻起失效</li>
            <li>可见性：选一条属性，设置哪些角色「知道」它（witnessed=目击 / rumor=传闻），配合顶部「角色视角」使用</li>
          </ul>
          <h4>角色视角</h4>
          <ul>
            <li>顶部选角色后，TA 不知道的实体和属性全部置灰，编辑器里不可见属性被锁定；选「关闭视角」退出</li>
          </ul>
          <h4>事件链页签</h4>
          <ul>
            <li>按故事时间排列每一次世界变更；蓝色「人工」＝你在本界面编辑产生，灰色「引擎」＝引擎自动产生</li>
            <li>点击事件卡片展开详情（新增 / 闭合的声明、因果来源），「由 xx 引起」可点击跳转到来源事件</li>
          </ul>
        </div>
        <template #footer>
          <el-button type="primary" @click="$emit('update:modelValue', false)">知道了</el-button>
        </template>
      </el-dialog>
    `
  };
})();
