import { useEffect, useState } from 'react'
import {
  createProfile,
  deleteProfile,
  setActiveProfile,
  updateProfile,
} from '../lib/api'
import { useI18n } from '../lib/i18n'
import type { CardProfile, ProfilesResponse } from '../lib/types'

interface Props {
  profiles: CardProfile[]
  activeId: string
  onReload: () => Promise<ProfilesResponse | null>
  onClose: () => void
}

interface DraftLevel {
  key: string
  id: string
  label: string
  stop: string
}

interface Draft {
  id: string
  label: string
  axis_label: string
  default_level: string
  max_chars: string
  sections: string[]
  levels: DraftLevel[]
  system: string
}

const MIN_LEVELS = 2
const MAX_LEVELS = 9
const ID_RE = /^[a-z0-9_-]+$/
const LEVEL_HINT = '2–9 档，从浅到深；stop 决定模型讲到哪停'

let keySeq = 0
function makeKey(): string {
  keySeq += 1
  return `level-${Date.now()}-${keySeq}`
}

function pickProfile(list: CardProfile[], id: string): CardProfile | null {
  return list.find((profile) => profile.id === id) ?? list[0] ?? null
}

function toDraft(profile: CardProfile): Draft {
  return {
    id: profile.id,
    label: profile.label,
    axis_label: profile.axis_label,
    default_level: profile.default_level,
    max_chars: String(profile.max_chars),
    sections: [...profile.sections],
    levels: profile.levels.map((level, index) => ({
      key: `${level.id}-${index}`,
      id: level.id,
      label: level.label,
      stop: level.stop,
    })),
    system: profile.system,
  }
}

/** 从 label 生成 id；中文等无法转写时保留原 id，保证稳定。 */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[\s/]+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '')
}

function nextLevelId(
  label: string,
  currentId: string,
  levels: DraftLevel[],
  index: number,
): string {
  const taken = new Set(levels.filter((_, i) => i !== index).map((level) => level.id))
  const base = slugify(label)
  if (base && !taken.has(base)) return base
  if (currentId && !taken.has(currentId)) return currentId
  let n = index + 1
  while (taken.has(`level_${n}`)) n += 1
  return `level_${n}`
}

function validateDraft(draft: Draft): string[] {
  const problems: string[] = []
  if (!draft.label.trim()) problems.push('模板名不能为空')
  if (draft.levels.length < MIN_LEVELS || draft.levels.length > MAX_LEVELS) {
    problems.push(`档位需要 ${MIN_LEVELS}–${MAX_LEVELS} 个`)
  }
  const seen = new Set<string>()
  draft.levels.forEach((level, index) => {
    if (!level.label.trim()) problems.push(`第 ${index + 1} 档缺少名称`)
    if (!level.stop.trim()) problems.push(`第 ${index + 1} 档缺少 stop 说明`)
    if (!ID_RE.test(level.id)) {
      problems.push(`第 ${index + 1} 档 id 不合法：${level.id || '空'}（只允许 a-z 0-9 _ -）`)
    }
    if (seen.has(level.id)) problems.push(`档位 id 重复：${level.id}`)
    seen.add(level.id)
  })
  if (!draft.levels.some((level) => level.id === draft.default_level)) {
    problems.push('默认档位不在档位列表里')
  }
  const maxChars = Number(draft.max_chars)
  if (draft.max_chars.trim() !== '' && (!Number.isInteger(maxChars) || maxChars <= 0)) {
    problems.push('字数上限需要是正整数（留空用默认 260）')
  }
  if (draft.sections.length === 0) problems.push('至少保留一个输出小节')
  if (draft.sections.some((section) => !section.trim())) {
    problems.push('小节名不能为空')
  }
  return problems
}

function toPayload(draft: Draft): Omit<CardProfile, 'id'> {
  return {
    label: draft.label.trim(),
    axis_label: draft.axis_label.trim(),
    default_level: draft.default_level,
    max_chars: draft.max_chars.trim() === '' ? 0 : Number(draft.max_chars),
    sections: draft.sections.map((section) => section.trim()),
    levels: draft.levels.map((level) => ({
      id: level.id,
      label: level.label.trim(),
      stop: level.stop.trim(),
    })),
    system: draft.system,
  }
}

export function ProfilesModal({ profiles, activeId, onReload, onClose }: Props) {
  const { t } = useI18n()
  const initial = pickProfile(profiles, activeId)
  const [list, setList] = useState<CardProfile[]>(profiles)
  const [active, setActive] = useState(activeId)
  const [selectedId, setSelectedId] = useState<string | null>(initial?.id ?? null)
  const [draft, setDraft] = useState<Draft | null>(initial ? toDraft(initial) : null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [attempted, setAttempted] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)

  const effectiveActive = active || list[0]?.id || ''
  const problems = draft ? validateDraft(draft) : []

  const reload = async (preferredId?: string | null): Promise<CardProfile | null> => {
    setBusy(true)
    try {
      const data = await onReload()
      if (!data) {
        setError(t('模板列表加载失败，后端可能还没就绪'))
        return null
      }
      const wanted = preferredId ?? selectedId ?? ''
      const next =
        data.profiles.find((profile) => profile.id === wanted) ??
        data.profiles.find((profile) => profile.id === data.active) ??
        data.profiles[0] ??
        null
      setList(data.profiles)
      setActive(data.active)
      setSelectedId(next?.id ?? null)
      setDraft(next ? toDraft(next) : null)
      setDeleteArmed(false)
      return next
    } catch (err) {
      setError(String(err))
      return null
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void reload()
    // 只在打开时拉一次最新列表；后续变更由各动作自己刷新。
  }, [])

  const selectProfile = (profile: CardProfile) => {
    setSelectedId(profile.id)
    setDraft(toDraft(profile))
    setDeleteArmed(false)
    setError(null)
    setNotice(null)
    setAttempted(false)
  }

  const updateDraft = (patch: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  const updateLevel = (index: number, patch: { label?: string; stop?: string }) => {
    setDraft((current) => {
      if (!current) return current
      const old = current.levels[index]
      if (!old) return current
      const id =
        patch.label !== undefined
          ? nextLevelId(patch.label, old.id, current.levels, index)
          : old.id
      const levels = current.levels.map((level, i) =>
        i === index ? { ...level, ...patch, id } : level,
      )
      return {
        ...current,
        levels,
        default_level: current.default_level === old.id ? id : current.default_level,
      }
    })
  }

  const moveLevel = (index: number, delta: number) => {
    setDraft((current) => {
      if (!current) return current
      const target = index + delta
      if (target < 0 || target >= current.levels.length) return current
      const levels = [...current.levels]
      const [moved] = levels.splice(index, 1)
      levels.splice(target, 0, moved)
      return { ...current, levels }
    })
  }

  const removeLevel = (index: number) => {
    if (!draft || draft.levels.length <= MIN_LEVELS) {
      setError(t('至少保留两档'))
      return
    }
    const removed = draft.levels[index]
    const levels = draft.levels.filter((_, i) => i !== index)
    setDraft({
      ...draft,
      levels,
      default_level:
        draft.default_level === removed.id ? (levels[0]?.id ?? '') : draft.default_level,
    })
    setError(null)
  }

  const addLevel = () => {
    if (!draft) return
    if (draft.levels.length >= MAX_LEVELS) {
      setError(t('最多九档'))
      return
    }
    const taken = new Set(draft.levels.map((level) => level.id))
    let n = draft.levels.length + 1
    while (taken.has(`level_${n}`)) n += 1
    const level: DraftLevel = { key: makeKey(), id: `level_${n}`, label: '新档位', stop: '' }
    setDraft({
      ...draft,
      levels: [...draft.levels, level],
      default_level: draft.default_level || level.id,
    })
    setError(null)
  }

  const updateSection = (index: number, value: string) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            sections: current.sections.map((section, i) => (i === index ? value : section)),
          }
        : current,
    )
  }

  const moveSection = (index: number, delta: number) => {
    setDraft((current) => {
      if (!current) return current
      const target = index + delta
      if (target < 0 || target >= current.sections.length) return current
      const sections = [...current.sections]
      const [moved] = sections.splice(index, 1)
      sections.splice(target, 0, moved)
      return { ...current, sections }
    })
  }

  const removeSection = (index: number) => {
    if (!draft) return
    if (draft.sections.length <= 1) {
      setError(t('至少保留一个小节'))
      return
    }
    setDraft({ ...draft, sections: draft.sections.filter((_, i) => i !== index) })
    setError(null)
  }

  const addSection = () => {
    setDraft((current) =>
      current ? { ...current, sections: [...current.sections, ''] } : current,
    )
    setError(null)
  }

  const save = async () => {
    if (!draft || busy) return
    setAttempted(true)
    if (validateDraft(draft).length > 0) {
      setError(null)
      setNotice(null)
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const updated = await updateProfile(draft.id, toPayload(draft))
      const next = await reload(updated.id)
      if (next) setNotice(t('已保存'))
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const duplicate = async () => {
    if (!draft || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const created = await createProfile({
        from: draft.id,
        label: `${draft.label.trim() || t('模板')} 副本`,
      })
      const next = await reload(created.id)
      if (next) setNotice(t('已创建副本'))
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const createNew = async () => {
    if (busy) return
    const seed = draft ?? pickProfile(list, effectiveActive)
    if (!seed) {
      setError(t('还没有可复制的模板'))
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const created = await createProfile({ from: seed.id, label: t('新模板') })
      const next = await reload(created.id)
      if (next) setNotice(t('已创建模板'))
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!draft || busy) return
    if (effectiveActive === draft.id || list.length <= 1) return
    if (!deleteArmed) {
      setDeleteArmed(true)
      setError(null)
      setNotice(t('再点一次「删除」确认'))
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await deleteProfile(draft.id)
      await reload()
      setNotice(t('已删除'))
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
      setDeleteArmed(false)
    }
  }

  const makeDefault = async () => {
    if (!draft || busy || effectiveActive === draft.id) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const nextActive = await setActiveProfile(draft.id)
      await reload(nextActive)
      setNotice(t('已设为新会话默认'))
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const deleteBlocked = !draft || effectiveActive === draft.id || list.length <= 1
  const deleteBlockedReason =
    list.length <= 1 ? t('至少保留一个模板') : t('新会话默认模板不能删除')

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal profiles-modal"
        role="dialog"
        aria-label={t('卡片模板')}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <strong>{t('卡片模板')}</strong>
          <button className="icon" onClick={onClose} title={t('关闭')}>
            ×
          </button>
        </header>

        <div className="profiles-body">
          <aside className="profiles-list">
            <div className="profiles-list-head">
              <span className="muted small">{t('模板决定卡片的轴与小节')}</span>
              <button onClick={() => void createNew()} disabled={busy || list.length === 0}>
                + {t('新建')}
              </button>
            </div>
            {list.map((profile) => (
              <button
                key={profile.id}
                className={`profile-item ${profile.id === selectedId ? 'selected' : ''}`}
                onClick={() => selectProfile(profile)}
                disabled={busy}
              >
                <span className="profile-item-top">
                  <span className="profile-name">{profile.label}</span>
                  {effectiveActive === profile.id && <span className="profile-badge">{t('新会话默认')}</span>}
                </span>
                <span className="profile-meta">
                  {profile.axis_label} · {profile.levels.length} 档
                </span>
              </button>
            ))}
            {list.length === 0 && <p className="muted small">{t('还没有模板。')}</p>}
          </aside>

          <section className="profiles-editor">
            {draft ? (
              <>
                <div className="profile-title">
                  <strong>{draft.label || t('未命名模板')}</strong>
                  <span className="muted small">id: {draft.id}</span>
                </div>

                <div className="profile-grid">
                  <label className="profile-field">
                    <span>{t('模板名')}</span>
                    <input
                      value={draft.label}
                      onChange={(event) => updateDraft({ label: event.target.value })}
                      placeholder={t('比如：法律')}
                    />
                  </label>
                  <label className="profile-field">
                    <span>{t('轴名称')}</span>
                    <input
                      value={draft.axis_label}
                      onChange={(event) => updateDraft({ axis_label: event.target.value })}
                      placeholder={t('比如：理解深度（可留空）')}
                    />
                  </label>
                  <label className="profile-field">
                    <span>{t('字数上限')}</span>
                    <input
                      type="number"
                      min={40}
                      value={draft.max_chars}
                      placeholder={t('留空用默认 260')}
                      onChange={(event) => updateDraft({ max_chars: event.target.value })}
                    />
                  </label>
                  <label className="profile-field">
                    <span>{t('默认档位')}</span>
                    <select
                      value={draft.default_level}
                      onChange={(event) => updateDraft({ default_level: event.target.value })}
                    >
                      {draft.levels.map((level) => (
                        <option key={level.key} value={level.id}>
                          {level.label || level.id}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <section className="profile-block">
                  <div className="profile-block-head">
                    <strong>{t('档位')}</strong>
                    <span className="muted small">{t(LEVEL_HINT)}</span>
                  </div>
                  {draft.levels.map((level, index) => (
                    <div className="level-row" key={level.key}>
                      <div className="level-fields">
                        <div className="level-top">
                          <input
                            value={level.label}
                            onChange={(event) => updateLevel(index, { label: event.target.value })}
                            placeholder={t('比如：能调')}
                          />
                          <span
                            className={`level-id ${ID_RE.test(level.id) ? '' : 'bad'}`}
                            title={t('由名称生成，稳定且唯一')}
                          >
                            #{level.id}
                          </span>
                        </div>
                        <textarea
                          rows={2}
                          value={level.stop}
                          onChange={(event) => updateLevel(index, { stop: event.target.value })}
                          placeholder={t('讲到哪停：只要会用就说到…')}
                        />
                      </div>
                      <div className="row-actions">
                        <button
                          className="icon"
                          title={t('上移')}
                          disabled={busy || index === 0}
                          onClick={() => moveLevel(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          className="icon"
                          title={t('下移')}
                          disabled={busy || index === draft.levels.length - 1}
                          onClick={() => moveLevel(index, 1)}
                        >
                          ↓
                        </button>
                        <button
                          className="icon danger"
                          title={t('删除这一档')}
                          disabled={busy || draft.levels.length <= MIN_LEVELS}
                          onClick={() => removeLevel(index)}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    className="link"
                    onClick={addLevel}
                    disabled={busy || draft.levels.length >= MAX_LEVELS}
                  >
                    + {t('加一档')}
                  </button>
                </section>

                <section className="profile-block">
                  <div className="profile-block-head">
                    <strong>{t('小节 / 结构')}</strong>
                    <span className="muted small">{t('会按这个顺序注入「严格按以下小节输出」')}</span>
                  </div>
                  {draft.sections.map((section, index) => (
                    <div className="section-row" key={index}>
                      <input
                        value={section}
                        onChange={(event) => updateSection(index, event.target.value)}
                        placeholder={t('比如：一句话定义')}
                      />
                      <div className="row-actions">
                        <button
                          className="icon"
                          title={t('上移')}
                          disabled={busy || index === 0}
                          onClick={() => moveSection(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          className="icon"
                          title={t('下移')}
                          disabled={busy || index === draft.sections.length - 1}
                          onClick={() => moveSection(index, 1)}
                        >
                          ↓
                        </button>
                        <button
                          className="icon danger"
                          title={t('删除这个小节')}
                          disabled={busy || draft.sections.length <= 1}
                          onClick={() => removeSection(index)}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  ))}
                  <button className="link" onClick={addSection} disabled={busy}>
                    + {t('加一个小节')}
                  </button>
                </section>

                <details className="profile-advanced">
                  <summary>{t('高级：系统提示词')}</summary>
                  <textarea
                    className="mono"
                    rows={8}
                    value={draft.system}
                    onChange={(event) => updateDraft({ system: event.target.value })}
                    placeholder={t('你是「卡片」…')}
                  />
                </details>
              </>
            ) : (
              <div className="profiles-empty">
                <p className="muted">{t('还没有模板。')}</p>
                <p className="muted small">{t('后端就绪后，这里会列出内置模板。')}</p>
              </div>
            )}

            {attempted && problems.length > 0 && (
              <ul className="profile-problems">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
            {error && <p className="err-msg">{error}</p>}
            {!error && notice && <p className="ok-msg">{notice}</p>}
          </section>
        </div>

        <footer className="profiles-foot">
          <div className="profiles-foot-group">
            <button
              onClick={() => void makeDefault()}
              disabled={busy || !draft || effectiveActive === draft.id}
            >
              {draft && effectiveActive === draft.id ? t('新会话默认') : t('设为新会话默认')}
            </button>
            <button
              className="danger"
              onClick={() => void remove()}
              disabled={busy || deleteBlocked}
              title={deleteBlocked ? deleteBlockedReason : t('会删除这个模板')}
            >
              {deleteArmed ? t('再点一次确认删除') : t('删除')}
            </button>
          </div>
          <div className="profiles-foot-group">
            <button onClick={() => void duplicate()} disabled={busy || !draft}>
              {t('另存为副本')}
            </button>
            <button className="primary" onClick={() => void save()} disabled={busy || !draft}>
              {busy ? t('处理中…') : t('保存')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
