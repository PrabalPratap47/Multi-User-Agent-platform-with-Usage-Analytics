import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useAsyncData } from '../../hooks/useAsyncData.js';
import { useAuthStore } from '../../store/authStore.js';
import { skillsGapService } from '../../services/skillsGapService.js';
import { apiErrorMessage } from '../../utils/apiError.js';
import { categoryLabel } from '../../utils/categoryLabels.js';
import { ACCEPTED_CV_EXTENSIONS, ACCEPTED_CV_MIME_TYPES, PDF_MIME_TYPE, checkCvFile } from '../../utils/cvFiles.js';
import type { GapPriority, SkillsGapAnalysis, SkillsGapGap, SkillsGapResult, SkillsGapRole } from '../../types/index.js';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../analytics/AnalyticsPrimitives.js';

const PRIORITIES: GapPriority[] = ['High', 'Medium', 'Low'];
const PRIORITY_STYLE: Record<GapPriority, string> = {
  High: 'bg-rose-100 text-rose-800 border-rose-200',
  Medium: 'bg-amber-100 text-amber-800 border-amber-200',
  Low: 'bg-slate-100 text-slate-700 border-slate-200',
};

const hoursRange = (t: { minHours: number; maxHours: number }) => (t.minHours === t.maxHours ? `≈ ${t.minHours} h` : `≈ ${t.minHours}–${t.maxHours} h`);

function Chips({ items }: { items: string[] }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {items.map(item => (
        <span key={item} className="rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-800">
          {item}
        </span>
      ))}
    </div>
  );
}

/** Summaries saved before the prompt change could contain this phrase; that sentence is not shown. */
function displaySummary(summary: string): string {
  return summary
    .split(/(?<=[.!?])[ ]+/)
    .filter(sentence => !/ai-generated learning aid/i.test(sentence))
    .join(' ');
}

function GapItem({ gap }: { gap: SkillsGapGap }) {
  return (
    <li>
      <details className="group rounded-lg border border-rose-200 bg-white">
        <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3">
          <span className="font-medium text-gray-900">{gap.skill}</span>
          <span className="text-xs text-gray-600">{hoursRange(gap.estimatedLearningTime)} (approximate)</span>
        </summary>
        <div className="space-y-3 border-t border-rose-100 px-4 py-3 text-sm text-gray-800">
          <p className="text-xs italic text-gray-600">Not demonstrated in the submitted CV.</p>
          <div>
            <p className="font-semibold text-gray-900">Why it matters</p>
            <p>{gap.whyItMatters}</p>
          </div>
          <div>
            <p className="font-semibold text-gray-900">What to understand</p>
            <p>{gap.whatToUnderstand}</p>
          </div>
          <div>
            <p className="font-semibold text-gray-900">Topics to study</p>
            <Chips items={gap.topics} />
          </div>
          <div>
            <p className="font-semibold text-gray-900">Practical exercise</p>
            <p>{gap.practicalExercise}</p>
          </div>
          {gap.miniProject && (
            <div>
              <p className="font-semibold text-gray-900">Suggested mini-project</p>
              <p>{gap.miniProject}</p>
            </div>
          )}
          <div>
            <p className="font-semibold text-gray-900">Done when</p>
            <p>{gap.completionCriterion}</p>
          </div>
        </div>
      </details>
    </li>
  );
}

function AnalysisView({ analysis }: { analysis: SkillsGapAnalysis }) {
  const r: SkillsGapResult = analysis.result;
  const prep = r.estimatedPreparationTime;
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm text-gray-600">
          Target role <strong className="text-gray-900">{categoryLabel(r.targetRole)}</strong>
          {analysis.cvFileName && <> · {analysis.cvFileName}</>} · {new Date(analysis.createdAt).toLocaleString()}
          {analysis.user && <> · {analysis.user.email}</>}
        </p>
        <p className="text-gray-800">{displaySummary(r.overallSummary)}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4" aria-label="Skills summary">
        <div className="rounded-lg border border-green-200 bg-green-50 p-3">
          <p className="text-2xl font-bold text-green-800">{r.demonstratedSkills.length}</p>
          <p className="text-sm text-green-900">Demonstrated</p>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-2xl font-bold text-amber-800">{r.partiallyDemonstratedSkills.length}</p>
          <p className="text-sm text-amber-900">Partially demonstrated</p>
        </div>
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
          <p className="text-2xl font-bold text-rose-800">{r.potentialGaps.length}</p>
          <p className="text-sm text-rose-900">Potential gaps</p>
        </div>
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
          <p className="text-2xl font-bold text-blue-800">
            {prep.minWeeks === prep.maxWeeks ? prep.minWeeks : `${prep.minWeeks}–${prep.maxWeeks}`} wk
          </p>
          <p className="text-sm text-blue-900">Approx. preparation at ~{prep.hoursPerWeekAssumed} h/week</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section aria-label="Demonstrated skills">
          <h4 className="mb-2 font-semibold text-gray-900">Demonstrated skills</h4>
          {r.demonstratedSkills.length === 0 ? (
            <p className="text-sm italic text-gray-600">None of the role skills is clearly demonstrated in the CV.</p>
          ) : (
            <ul className="space-y-2">
              {r.demonstratedSkills.map(s => (
                <li key={s.skill} className="rounded-md border-l-4 border-green-600 bg-green-50 p-3 text-sm">
                  <p className="font-medium text-gray-900">{s.skill}</p>
                  <p className="mt-1 italic text-gray-700">“{s.evidence}”</p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label="Partially demonstrated skills">
          <h4 className="mb-2 font-semibold text-gray-900">Partially demonstrated skills</h4>
          {r.partiallyDemonstratedSkills.length === 0 ? (
            <p className="text-sm italic text-gray-600">None.</p>
          ) : (
            <ul className="space-y-2">
              {r.partiallyDemonstratedSkills.map(s => (
                <li key={s.skill} className="rounded-md border-l-4 border-amber-500 bg-amber-50 p-3 text-sm">
                  <p className="font-medium text-gray-900">{s.skill}</p>
                  <p className="mt-1 italic text-gray-700">“{s.evidence}”</p>
                  <p className="mt-1 text-gray-800">
                    <span className="font-medium">Not shown:</span> {s.missingEvidence}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section aria-label="Potential gaps">
        <h4 className="font-semibold text-gray-900">Potential gaps and learning guidance</h4>
        {r.potentialGaps.length === 0 ? (
          <p className="mt-1 text-sm italic text-gray-600">No potential gaps: every role skill is at least partially demonstrated.</p>
        ) : (
          <div className="mt-2 space-y-4">
            {PRIORITIES.map(priority => {
              const gaps = r.potentialGaps.filter(g => g.priority === priority);
              if (gaps.length === 0) return null;
              return (
                <div key={priority}>
                  <p className="mb-2">
                    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${PRIORITY_STYLE[priority]}`}>
                      {priority} priority · {gaps.length}
                    </span>
                  </p>
                  <ul className="space-y-2">
                    {gaps.map(gap => (
                      <GapItem key={gap.skill} gap={gap} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section aria-label="Learning roadmap">
        <h4 className="font-semibold text-gray-900">Learning roadmap</h4>
        <ol className="mt-2 space-y-3">
          {r.learningRoadmap.map(stage => (
            <li key={stage.stage} className="flex gap-3 rounded-lg border border-gray-200 p-4">
              <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">
                {stage.stage}
              </span>
              <div className="min-w-0 space-y-1 text-sm text-gray-800">
                <p className="font-semibold text-gray-900">
                  Stage {stage.stage}: {stage.title}
                </p>
                <p>{stage.objective}</p>
                <Chips items={stage.topics} />
                <p>
                  <span className="font-medium">Practical task:</span> {stage.practicalTask}
                </p>
                <p>
                  <span className="font-medium">Done when:</span> {stage.completionCriteria}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-gray-600">
          Estimated preparation time is approximate: {prep.note}
        </p>
      </section>
    </div>
  );
}

/** Admin-only (also enforced by the server): confirm, then delete; the list updates only after the server confirms. */
function DeleteAnalysisButton({ analysis, onDeleted }: { analysis: SkillsGapAnalysis; onDeleted: (analysis: SkillsGapAnalysis) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = analysis.cvFileName ?? 'CV';

  const confirmDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await skillsGapService.remove(analysis.id);
      dialog.current?.close();
      onDeleted(analysis);
    } catch (err) {
      setError(apiErrorMessage(err, 'The analysis could not be deleted. Nothing was removed.'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          dialog.current?.showModal();
        }}
        aria-label={`Delete analysis #${analysis.id} (${name})`}
        className="rounded-md border border-red-200 bg-white px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-50"
      >
        Delete
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onCancel={e => {
          if (deleting) e.preventDefault();
        }}
        className="w-[calc(100%-2rem)] max-w-md rounded-lg p-0 shadow-xl backdrop:bg-gray-900/50"
      >
        <div className="space-y-3 p-5">
          <h4 id={titleId} className="text-lg font-semibold text-gray-900">
            Delete this CV analysis permanently?
          </h4>
          <p className="text-sm text-gray-700">
            <strong className="break-all">{name}</strong> (analysis #{analysis.id}, {categoryLabel(analysis.targetRole)}
            {analysis.user && <>, {analysis.user.email}</>}) and its saved results will be permanently deleted. This cannot be undone.
          </p>
          <p className="text-sm text-gray-600">Token usage and cost records for its processing are kept.</p>
          {error && (
            <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              disabled={deleting}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              disabled={deleting}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Delete permanently'}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}

export function SkillsGapTab() {
  const isAdmin = useAuthStore(state => state.user?.role === 'admin');
  const roles = useAsyncData(() => skillsGapService.getRoles(), []);
  const [version, setVersion] = useState(0);
  const saved = useAsyncData(() => skillsGapService.list(), [version]);
  const [role, setRole] = useState<SkillsGapRole | ''>('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SkillsGapAnalysis | null>(null);
  // Hidden as soon as the server confirms a deletion, until the refreshed list arrives without them.
  const [deletedIds, setDeletedIds] = useState<number[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const visible = saved.data?.filter(a => !deletedIds.includes(a.id)) ?? null;

  const handleDeleted = (analysis: SkillsGapAnalysis) => {
    setDeletedIds(ids => [...ids, analysis.id]);
    setSelected(current => (current?.id === analysis.id ? null : current));
    setNotice(`Analysis #${analysis.id} (${analysis.cvFileName ?? 'CV'}) was deleted.`);
    setVersion(v => v + 1);
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!role && roles.data?.length) setRole(roles.data[0].role);
  }, [roles.data, role]);

  const open = (analysis: SkillsGapAnalysis) => {
    setSelected(analysis);
    requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const file = fileInput.current?.files?.[0];
    if (!file) return setError('Choose a .txt or .pdf CV file first.');
    if (!role) return setError('Choose a target role.');
    // The same checks as CV Processing: type, size, PDF signature, text length.
    const checked = await checkCvFile(file, 0);
    if (!checked.ok) return setError(checked.reason);

    setRunning(true);
    try {
      const { payload } = checked;
      const analysis = await skillsGapService.analyze(
        payload.mimeType === PDF_MIME_TYPE
          ? { targetRole: role, fileName: payload.fileName, pdfBase64: payload.content }
          : { targetRole: role, fileName: payload.fileName, cvContent: payload.content }
      );
      setVersion(v => v + 1);
      open(analysis);
    } catch (err) {
      setError(apiErrorMessage(err, 'The analysis failed. Please try again.'));
    } finally {
      setRunning(false);
    }
  };

  const roleInfo = roles.data?.find(r => r.role === role);

  return (
    <div className="space-y-6">
      <SectionCard
        title="Skills Gap Analysis"
        description="Compare the skills your CV demonstrates with a target role and get a prioritized learning plan for the gaps. Separate from CV classification: it never changes a classification decision."
      >
        {roles.loading && !roles.data && <LoadingState label="Loading roles..." />}
        {roles.error && <ErrorState message={roles.error} onRetry={roles.reload} />}
        {roles.data && (
          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="skills-gap-file" className="block text-sm font-medium text-gray-700">
                  CV file (.txt or text-based .pdf)
                </label>
                <input
                  id="skills-gap-file"
                  ref={fileInput}
                  type="file"
                  accept={`${ACCEPTED_CV_EXTENSIONS},${ACCEPTED_CV_MIME_TYPES}`}
                  disabled={running}
                  className="mt-1 block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100 disabled:opacity-50"
                />
              </div>
              <div>
                <label htmlFor="skills-gap-role" className="block text-sm font-medium text-gray-700">
                  Target role
                </label>
                <select
                  id="skills-gap-role"
                  value={role}
                  onChange={e => setRole(e.target.value as SkillsGapRole)}
                  disabled={running}
                  className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {roles.data.map(r => (
                    <option key={r.role} value={r.role}>
                      {r.label}
                    </option>
                  ))}
                </select>
                {roleInfo && (
                  <p className="mt-1 text-xs text-gray-600">
                    {roleInfo.summary} {roleInfo.skills.length} expected skills.
                  </p>
                )}
              </div>
            </div>
            {error && (
              <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
                {error}
              </p>
            )}
            {running && (
              <p role="status" className="text-sm text-gray-600">
                Analyzing the CV for {categoryLabel(role)}... this usually takes under a minute.
              </p>
            )}
            <button type="submit" disabled={running} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {running ? 'Analyzing...' : 'Analyze CV'}
            </button>
          </form>
        )}
      </SectionCard>

      {selected && (
        <div ref={resultRef} className="scroll-mt-32">
          <SectionCard title={`Analysis #${selected.id}`}>
            <AnalysisView analysis={selected} />
          </SectionCard>
        </div>
      )}

      <SectionCard title={isAdmin ? 'Saved analyses (all users)' : 'Your saved analyses'} description="Newest first.">
        {saved.loading && !saved.data && <LoadingState label="Loading analyses..." />}
        {saved.error && <ErrorState message={saved.error} onRetry={saved.reload} />}
        {notice && (
          <p role="status" className="mb-3 rounded border border-green-200 bg-green-50 p-2 text-sm text-green-800">
            {notice}
          </p>
        )}
        {visible && visible.length === 0 && <EmptyState message="No analyses yet. Upload a CV above to get started." />}
        {visible && visible.length > 0 && (
          <ul className="divide-y divide-gray-100">
            {visible.map(a => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 py-3">
                <div className="min-w-[12rem] flex-1 text-sm">
                  <p className="font-medium text-gray-900">
                    #{a.id} · {categoryLabel(a.targetRole)}
                  </p>
                  <p className="break-all text-xs text-gray-600">
                    {a.cvFileName ?? 'CV'} · {new Date(a.createdAt).toLocaleString()}
                    {isAdmin && a.user && <> · {a.user.email}</>} · {a.result.demonstratedSkills.length} demonstrated,{' '}
                    {a.result.partiallyDemonstratedSkills.length} partial, {a.result.potentialGaps.length} gaps
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => open(a)}
                  aria-label={`Open analysis #${a.id}`}
                  className="rounded-md border border-gray-300 bg-white px-3 py-1 text-sm text-gray-700 hover:bg-gray-100"
                >
                  {selected?.id === a.id ? 'Open (shown above)' : 'Open'}
                </button>
                {isAdmin && <DeleteAnalysisButton analysis={a} onDeleted={handleDeleted} />}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
