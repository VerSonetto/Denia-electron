import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import * as api from '../../api'
import * as skillsApi from '../../skillsApi'
import type { ManagedSkill, SkillScope } from '../../skillsApi'
import { ConfirmDialog } from '../ConfirmDialog'
import { Button, Field, TextInput } from '../llm/atoms/form'
import styles from './SkillsManager.module.css'

type SourceFilter = 'all' | 'user' | 'project' | 'builtin'
type Editor = { name: string; content: string; create: boolean; readonly: boolean; scope: SkillScope }
const sources: { id: SourceFilter; label: string }[] = [
  { id: 'all', label: '全部' }, { id: 'user', label: '用户' },
  { id: 'project', label: '项目' }, { id: 'builtin', label: '内置' },
]

function sourceKind(skill: ManagedSkill): SourceFilter {
  if (skill.source.startsWith('project')) return 'project'
  if (skill.source.startsWith('user')) return 'user'
  return 'builtin'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function SkillModal({ title, busy, onClose, children }: {
  title: string; busy: boolean; onClose: () => void; children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog ref={ref} className={styles.modal} aria-label={title}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
      <header className={styles.modalHeader}><h2>{title}</h2><Button disabled={busy} onClick={onClose}>关闭</Button></header>
      {children}
    </dialog>
  )
}

export function SkillsManager({ cwd }: { cwd?: string }) {
  const [skills, setSkills] = useState<ManagedSkill[]>([])
  const [directory, setDirectory] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [importing, setImporting] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [scope, setScope] = useState<SkillScope>('user')
  const [modalError, setModalError] = useState('')
  const [deleting, setDeleting] = useState<ManagedSkill | null>(null)
  const generation = useRef(0)

  const reload = useCallback(async () => {
    const id = ++generation.current
    setLoading(true)
    try {
      const result = await skillsApi.listManagedSkills(cwd)
      if (id !== generation.current) return
      setSkills(result.skills)
      setDirectory(result.directory)
      setError('')
    } catch (err) {
      if (id === generation.current) setError(errorText(err))
    } finally {
      if (id === generation.current) setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    setSkills([])
    setDirectory('')
    setEditor(null)
    setImporting(false)
    setDeleting(null)
    void reload()
    return () => { generation.current++ }
  }, [reload])

  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try { await action() } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }

  const openDirectory = (path: string) => run(async () => {
    const { apps } = await api.getOpenInAppApps()
    const app = apps.find((id) => ['explorer', 'finder', 'filemanager'].includes(id))
    if (!app) throw new Error('未检测到可用的文件管理器，请复制目录路径后手动打开。')
    await api.openInAppOpen(app, path)
  })

  const editSkill = (skill: ManagedSkill) => run(async () => {
    const result = await skillsApi.getSkill(skill.name, cwd)
    setModalError('')
    setEditor({ name: skill.name, content: result.raw, create: false, readonly: !result.skill.editable || sourceKind(result.skill) === 'builtin', scope: 'user' })
  })

  const save = async () => {
    if (!editor || busy) return
    setBusy(true)
    setModalError('')
    try {
      await skillsApi.saveSkill(editor.name, editor.content, { cwd, create: editor.create, scope: editor.create ? editor.scope : undefined })
      setEditor(null)
      await reload()
    } catch (err) { setModalError(errorText(err)) } finally { setBusy(false) }
  }

  const doImport = async () => {
    if (busy) return
    setBusy(true)
    setModalError('')
    try {
      await skillsApi.importSkills(importPath.trim(), scope, cwd)
      setImporting(false)
      await reload()
    } catch (err) { setModalError(errorText(err)) } finally { setBusy(false) }
  }

  const needle = search.trim().toLowerCase()
  const visible = skills.filter((skill) => (filter === 'all' || sourceKind(skill) === filter)
    && `${skill.name} ${skill.description}`.toLowerCase().includes(needle))
  const nameError = editor?.create && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(editor.name)
    ? '名称只能包含小写字母、数字和单个连字符，例如 code-review。' : ''

  const scopeField = (value: SkillScope, onChange: (value: SkillScope) => void) => (
    <label className={styles.field}>保存位置
      <select value={value} disabled={busy} onChange={(event) => onChange(event.target.value as SkillScope)}>
        <option value="user">用户技能 · 所有项目可用</option>
        <option value="project" disabled={!cwd}>项目技能{cwd ? ' · 当前项目' : ' · 请先选择项目'}</option>
      </select>
    </label>
  )

  return (
    <section className={styles.manager} aria-label="技能管理">
      <header className={styles.header}>
        <div><h1>技能</h1><p>把常用流程写成技能，让助手在需要时使用。</p></div>
        <div className={styles.actions}>
          <Button disabled={busy || !directory} onClick={() => void openDirectory(directory)}>打开技能目录</Button>
          <Button disabled={busy} onClick={() => { setModalError(''); setImportPath(''); setScope('user'); setImporting(true) }}>导入本地目录</Button>
          <Button variant="primary" disabled={busy} onClick={() => {
            setModalError('')
            setEditor({ name: '', content: '---\nname: my-skill\ndescription: 描述技能的用途与适用场景\n---\n\n# 使用说明\n\n', create: true, readonly: false, scope: 'user' })
          }}>新建技能</Button>
        </div>
      </header>
      <div className={styles.toolbar}>
        <input className={styles.search} type="search" aria-label="搜索技能名称或描述" placeholder="搜索名称或描述…" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className={styles.filters} aria-label="技能来源">
          {sources.map((source) => <button type="button" key={source.id} aria-pressed={filter === source.id} onClick={() => setFilter(source.id)}>{source.label}</button>)}
        </div>
        <span className={styles.count} aria-live="polite">{visible.length} / {skills.length} 个技能</span>
      </div>
      {error && <div className={styles.error} role="alert">{error}<Button small onClick={() => void reload()} disabled={loading}>重试</Button></div>}
      {loading ? <p className={styles.empty} role="status">正在加载技能…</p> : error && skills.length === 0 ? null : visible.length === 0 ? (
        <div className={styles.empty}><h2>{skills.length ? '没有匹配的技能' : '还没有技能'}</h2><p>{skills.length ? '试试其他关键词或来源。' : '新建一个技能，或导入包含 SKILL.md 的本地目录。'}</p></div>
      ) : <div className={styles.grid}>
        {visible.map((skill) => {
          const builtin = sourceKind(skill) === 'builtin'
          return <article className={styles.card} key={`${skill.source}:${skill.name}`}>
            <div className={styles.cardHeader}><h2>{skill.name}</h2><span className={styles.badge} title={skill.source}>{sources.find((source) => source.id === sourceKind(skill))?.label}</span></div>
            <p className={styles.description} title={skill.description}>{skill.description || '暂无描述'}</p>
            <div className={styles.cardFooter}>
              <button type="button" role="switch" aria-checked={skill.enabled} aria-label={`${skill.enabled ? '停用' : '启用'} ${skill.name}`} className={styles.toggle} disabled={busy} onClick={() => void run(async () => { await skillsApi.setSkillEnabled(skill.name, !skill.enabled, cwd); await reload() })}><span className={styles.track}><span /></span>{skill.enabled ? '已启用' : '已停用'}</button>
              <div className={styles.cardActions}>
                <Button small disabled={busy || !skill.resourceBase} title={skill.resourceBase} onClick={() => void openDirectory(skill.resourceBase)}>打开目录</Button>
                <Button small disabled={busy} onClick={() => void editSkill(skill)}>{builtin || !skill.editable ? '查看' : '编辑'}</Button>
                {!builtin && skill.editable && <Button small variant="danger" disabled={busy} onClick={() => setDeleting(skill)}>删除</Button>}
              </div>
            </div>
          </article>
        })}
      </div>}
      {directory && <p className={styles.directory}>用户技能目录：<code>{directory}</code></p>}
      {editor && <SkillModal title={editor.create ? '新建技能' : `${editor.readonly ? '查看' : '编辑'} · ${editor.name}`} busy={busy} onClose={() => setEditor(null)}>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); if (!nameError && !editor.readonly) void save() }}>
          {editor.create && <><Field label="技能名称 *" hint="与下方 Markdown frontmatter 中的 name 保持一致。" error={editor.name ? nameError : undefined}><TextInput mono value={editor.name} placeholder="my-skill" disabled={busy} onChange={(name) => setEditor({ ...editor, name, content: editor.content.replace(/^name:.*$/m, `name: ${name || 'my-skill'}`) })} /></Field>{scopeField(editor.scope, (value) => setEditor({ ...editor, scope: value }))}</>}
          <label className={styles.field}>SKILL.md · 完整 Markdown{!editor.readonly && ' *'}<textarea className={styles.editor} value={editor.content} readOnly={editor.readonly} disabled={busy} spellCheck={false} required onChange={(event) => setEditor({ ...editor, content: event.target.value })} /></label>
          {editor.readonly && <p className={styles.hint}>此技能为只读，不能在这里编辑或删除。</p>}
          {modalError && <p className={styles.error} role="alert">{modalError}</p>}
          <footer className={styles.modalActions}><Button disabled={busy} onClick={() => setEditor(null)}>{editor.readonly ? '完成' : '取消'}</Button>{!editor.readonly && <Button type="submit" variant="primary" disabled={busy || !!nameError || !editor.content.trim()}>{busy ? '正在保存…' : '保存技能'}</Button>}</footer>
        </form>
      </SkillModal>}
      {importing && <SkillModal title="导入本地技能" busy={busy} onClose={() => setImporting(false)}>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void doImport() }}>
          <p className={styles.hint}>输入运行 Denia 的机器上的技能目录路径。目录需包含 SKILL.md；不会克隆远程仓库。</p>
          <Field label="本地目录路径 *"><TextInput mono value={importPath} disabled={busy} onChange={setImportPath} placeholder="包含 SKILL.md 的目录" /></Field>
          {scopeField(scope, setScope)}
          {modalError && <p className={styles.error} role="alert">{modalError}</p>}
          <footer className={styles.modalActions}><Button disabled={busy} onClick={() => setImporting(false)}>取消</Button><Button type="submit" variant="primary" disabled={busy || !importPath.trim()}>{busy ? '正在导入…' : '导入技能'}</Button></footer>
        </form>
      </SkillModal>}
      <ConfirmDialog open={!!deleting} title="删除技能？" desc={`将删除「${deleting?.name ?? ''}」的本地技能目录及其内容，此操作无法撤销。`} danger confirmLabel={busy ? '正在删除…' : '删除技能'} onCancel={() => { if (!busy) setDeleting(null) }} onConfirm={() => {
        if (!deleting || busy) return
        const name = deleting.name
        setDeleting(null)
        void run(async () => { await skillsApi.deleteSkill(name, cwd); await reload() })
      }} />
    </section>
  )
}
