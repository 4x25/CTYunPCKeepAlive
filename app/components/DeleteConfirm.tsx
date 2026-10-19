interface Props {
  /** 标题点名账号：有别名写「别名 掩码」，没填别名只写掩码 */
  label: string
  onConfirm: () => void
  onClose: () => void
}

/** 删除账号确认：标题点名账号，正文只讲三条后果（初始焦点由 ModalLayer 落在角落关闭按钮上） */
export default function DeleteConfirm({ label, onConfirm, onClose }: Props) {
  return (
    <div>
      <div class="flex items-start justify-between gap-3">
        <h3 id="dlg-del-t" class="text-base font-bold">
          是否删除{label}？
        </h3>
      </div>
      <div class="py-3 text-xs">
        <p>确认删除后将：</p>
        <ol class="mt-1.5 list-decimal space-y-0.5 pl-5 leading-relaxed">
          <li>停止现有执行中任务</li>
          <li>立即退出登录</li>
          <li>彻底删除相关配置</li>
        </ol>
      </div>
      <div class="modal-action mt-0">
        <button type="button" class="btn btn-sm" onClick={onClose}>
          取消
        </button>
        <button type="button" class="btn btn-error btn-sm" onClick={onConfirm}>
          删除账号
        </button>
      </div>
    </div>
  )
}
