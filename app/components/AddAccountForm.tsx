import { useState } from 'hono/jsx'
import type { Account } from '../lib/types'

export interface AddFormValues {
  acct: string
  pw: string
  alias: string
}

interface Props {
  /** null = 新增；否则为修正凭据态（预填本机保存的值，成功后替换该账号） */
  edit: Account | null
  busy: boolean
  onSubmit: (v: AddFormValues) => void
  onClose: () => void
}

/** 添加账号 / 重新登录·修正凭据 表单（挂在 ModalLayer 里） */
export default function AddAccountForm({ edit, busy, onSubmit, onClose }: Props) {
  const isFix = edit !== null
  const [acct, setAcct] = useState(edit?.full ?? '')
  const [pw, setPw] = useState(edit?.pw ?? '')
  const [alias, setAlias] = useState(edit?.alias ?? '')
  const [showPw, setShowPw] = useState(false)
  const [acctErr, setAcctErr] = useState('')
  const [pwErr, setPwErr] = useState('')

  /* 只做必填：账号与密码的格式一律不猜，交给服务端判 */
  const submit = () => {
    setAcctErr('')
    setPwErr('')
    if (!acct.trim()) {
      setAcctErr('请填写账号')
      return
    }
    if (!pw) {
      setPwErr('请填写密码')
      return
    }
    onSubmit({ acct: acct.trim(), pw, alias: alias.trim() })
  }

  return (
    <div>
      <div class="flex items-start justify-between gap-3">
        <h3 id="dlg-add-t" class="text-base font-bold">
          {isFix ? '重新登录 · 修正凭据' : '添加账号'}
        </h3>
      </div>

      <div class="py-3">
        {isFix && (
          <div class="mb-3 rounded-field border border-base-300 bg-base-200/60 px-3 py-2 text-[11.5px] leading-relaxed text-base-content/70">
            <b class="font-semibold text-base-content">这是修正凭据，不是新增。</b>
            下方已预填本机保存的账号与密码（<b class="font-semibold text-base-content">本工具唯一会回显密码的地方</b>
            ）。登录成功后先删除原账号再添加新的：保活间隔、时间窗口、各实例自动开关按位置继承，
            <b class="font-semibold text-base-content">原账号的日志会一并清除</b>。登录失败就停在这里，原账号保持原样。
          </div>
        )}

        <div class="mb-3">
          <label class="label p-0 pb-1 text-xs" for="f-acct">
            账号
          </label>
          <input
            id="f-acct"
            class={`input input-sm w-full font-mono ${acctErr ? 'input-error' : ''}`}
            type="text"
            autocomplete="off"
            spellcheck={false}
            placeholder="手机号 / 邮箱 / 账号名"
            value={acct}
            aria-invalid={acctErr ? 'true' : undefined}
            autofocus
            onInput={(e: Event) => setAcct((e.target as HTMLInputElement).value)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter') submit()
            }}
          />
          {acctErr && <p class="mt-1 text-xs font-medium text-error">{acctErr}</p>}
        </div>

        <div class="mb-3">
          <label class="label p-0 pb-1 text-xs" for="f-pw">
            密码
          </label>
          <div class="join w-full">
            <input
              id="f-pw"
              class={`input input-sm join-item w-full font-mono ${pwErr ? 'input-error' : ''}`}
              type={showPw ? 'text' : 'password'}
              autocomplete="off"
              value={pw}
              aria-invalid={pwErr ? 'true' : undefined}
              onInput={(e: Event) => setPw((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') submit()
              }}
            />
            <button
              type="button"
              class="btn btn-sm join-item"
              aria-pressed={showPw}
              aria-label={showPw ? '隐藏密码' : '显示密码'}
              onClick={() => setShowPw(!showPw)}
            >
              {showPw ? '隐藏' : '显示'}
            </button>
          </div>
          {pwErr && <p class="mt-1 text-xs font-medium text-error">{pwErr}</p>}
        </div>

        <div>
          <label class="label p-0 pb-1 text-xs" for="f-alias">
            别名（选填）
          </label>
          <input
            id="f-alias"
            class="input input-sm w-full"
            type="text"
            maxlength={12}
            placeholder="留空则用完整账号作 Tab 名"
            value={alias}
            onInput={(e: Event) => setAlias((e.target as HTMLInputElement).value)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter') submit()
            }}
          />
        </div>
      </div>

      <div class="modal-action mt-0">
        <button type="button" class="btn btn-sm" onClick={onClose}>
          取消
        </button>
        <button type="button" class="btn btn-neutral btn-sm" disabled={busy} onClick={submit}>
          {busy ? '登录中…' : isFix ? '登录并替换' : '登录并添加'}
        </button>
      </div>
    </div>
  )
}
