/**
 * DOM overlay for live benchmark + final report.
 */
function formatReportText(report) {
  if (!report) return '';
  const lines = [];
  const push = (s = '') => lines.push(s);

  push('BlockViewer Benchmark Report');
  push('============================');
  push(`version: ${report.version}`);
  push(`endReason: ${report.endReason}`);
  push(`durationSec: ${(report.durationMs / 1000).toFixed(3)}`);
  push(`maxDurationSec: ${(report.maxDurationMs / 1000).toFixed(1)}`);
  push(`stableMs: ${report.stableMs}`);
  push(`lock: yaw=${report.lock?.yaw} pitch=${report.lock?.pitch}`);
  push();

  push('-- Device --');
  const d = report.device || {};
  push(`userAgent: ${d.userAgent || 'n/a'}`);
  push(`platform: ${d.platform || 'n/a'}`);
  push(`hardwareConcurrency: ${d.hardwareConcurrency ?? 'n/a'}`);
  push(`deviceMemoryGB: ${d.deviceMemoryGB ?? 'n/a'}`);
  push(`devicePixelRatio: ${d.devicePixelRatio ?? 'n/a'}`);
  push(`viewport: ${d.viewport?.width}x${d.viewport?.height} css`);
  push(`devicePixelArea: ${d.viewport?.devicePixelArea ?? 'n/a'}`);
  if (d.connection) {
    push(`connection: ${d.connection.effectiveType || '?'} saveData=${d.connection.saveData}`);
  }
  push();

  push('-- Timing --');
  const t = report.timing || {};
  push(`timeToFirstMeshSec: ${t.timeToFirstMeshMs != null ? (t.timeToFirstMeshMs / 1000).toFixed(3) : 'n/a'}`);
  push(`timeToInitialLoadSec: ${t.timeToInitialLoadMs != null ? (t.timeToInitialLoadMs / 1000).toFixed(3) : 'n/a'}`);
  push(`timeToStableSec: ${t.timeToStableMs != null ? (t.timeToStableMs / 1000).toFixed(3) : 'n/a'}`);
  push();

  push('-- FPS --');
  const f = report.fps || {};
  push(`avg: ${f.avg?.toFixed?.(2) ?? f.avg}`);
  push(`p50: ${f.p50?.toFixed?.(2) ?? f.p50}`);
  push(`p1: ${f.p1?.toFixed?.(2) ?? f.p1}`);
  push(`p99: ${f.p99?.toFixed?.(2) ?? f.p99}`);
  push(`min: ${f.min?.toFixed?.(2) ?? f.min}`);
  push(`max: ${f.max?.toFixed?.(2) ?? f.max}`);
  push(`frames: ${f.frames}`);
  push();

  push('-- Frame hitches --');
  const fr = report.frames || {};
  push(`avgMs: ${fr.avgMs?.toFixed?.(2) ?? fr.avgMs}`);
  push(`p50Ms: ${fr.p50Ms?.toFixed?.(2) ?? fr.p50Ms}`);
  push(`p95Ms: ${fr.p95Ms?.toFixed?.(2) ?? fr.p95Ms}`);
  push(`p99Ms: ${fr.p99Ms?.toFixed?.(2) ?? fr.p99Ms}`);
  push(`maxMs: ${fr.maxMs?.toFixed?.(2) ?? fr.maxMs}`);
  push(`over33ms: ${fr.over33ms}`);
  push(`over50ms: ${fr.over50ms}`);
  push(`over100ms: ${fr.over100ms}`);
  push(`over200ms: ${fr.over200ms}`);
  push();

  push('-- Memory --');
  const m = report.memory || {};
  push(`peakUsedMB: ${m.peakUsedMB ? m.peakUsedMB.toFixed(1) : 'n/a'}`);
  push(`finalUsedMB: ${m.final?.usedJSHeapMB != null ? m.final.usedJSHeapMB.toFixed(1) : 'n/a'}`);
  push(`finalTotalMB: ${m.final?.totalJSHeapMB != null ? m.final.totalJSHeapMB.toFixed(1) : 'n/a'}`);
  push(`jsHeapLimitMB: ${m.final?.jsHeapLimitMB != null ? m.final.jsHeapLimitMB.toFixed(1) : 'n/a'}`);
  push(`note: ${m.note || ''}`);
  push();

  push('-- Long tasks --');
  push(`count: ${report.longTasks?.count ?? 0}`);
  push(`totalMs: ${report.longTasks?.totalMs?.toFixed?.(1) ?? report.longTasks?.totalMs ?? 0}`);
  push();

  push('-- World --');
  const w = report.world || {};
  push(`loadedChunks: ${w.loadedChunks ?? 'n/a'}`);
  push(`queuedChunks: ${w.queuedChunks ?? 'n/a'}`);
  push(`totalMeshes: ${w.totalMeshes ?? 'n/a'}`);
  push(`superChunkCount: ${w.superChunkCount ?? 'n/a'}`);
  push(`dirtyCount: ${w.dirtyCount ?? 'n/a'}`);
  push(`initialLoadComplete: ${w.initialLoadComplete}`);
  push(`renderDistance: ${w.renderDistance ?? 'n/a'}`);
  push(`chunkLoadingSpeed: ${w.chunkLoadingSpeed ?? 'n/a'}`);
  push(`dpr: ${w.dpr ?? 'n/a'}`);
  push(`targetResolution: ${w.targetResolution ?? 'n/a'}`);
  push();

  push('-- Timeline samples (tSec, fps, dtMs, heapMB, chunks, queued, meshes, dirty, pending, initialDone) --');
  for (const s of report.samples || []) {
    push([
      (s.t / 1000).toFixed(2),
      s.fps?.toFixed?.(1) ?? s.fps,
      s.dt?.toFixed?.(1) ?? s.dt,
      s.heapUsedMB != null ? s.heapUsedMB.toFixed(1) : 'n/a',
      s.loadedChunks,
      s.queuedChunks,
      s.totalMeshes,
      s.dirtyCount,
      s.pendingWork ? 1 : 0,
      s.initialLoadComplete ? 1 : 0,
    ].join('\t'));
  }
  push();
  push('-- Full JSON --');
  push(JSON.stringify(report, null, 2));
  push();
  return lines.join('\n');
}

function downloadReportTxt(report) {
  const text = formatReportText(report);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `blockviewer-benchmark-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function BenchmarkHud({ live, report, onDismiss }) {
  if (!live && !report) return null;

  const copyReport = async () => {
    if (!report) return;
    const text = formatReportText(report);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      console.log('[Benchmark] report\n', text);
    }
  };

  if (report) {
    const { fps, frames, memory, timing, world, endReason, durationMs, device } = report;
    return (
      <div className="benchmark-hud benchmark-hud--done">
        <div className="benchmark-hud__card">
          <h2>Benchmark complete</h2>
          <p className="benchmark-hud__reason">
            Ended: <strong>{endReason}</strong> · {(durationMs / 1000).toFixed(1)}s
          </p>
          <dl className="benchmark-hud__grid">
            <dt>FPS avg / p50 / p1</dt>
            <dd>
              {fps.avg.toFixed(1)} / {fps.p50.toFixed(1)} / {fps.p1.toFixed(1)}
            </dd>
            <dt>Frame hitches</dt>
            <dd>
              &gt;50ms {frames.over50ms} · &gt;100ms {frames.over100ms} · &gt;200ms {frames.over200ms}
            </dd>
            <dt>First mesh</dt>
            <dd>{timing.timeToFirstMeshMs != null ? `${(timing.timeToFirstMeshMs / 1000).toFixed(2)}s` : '—'}</dd>
            <dt>Initial load</dt>
            <dd>{timing.timeToInitialLoadMs != null ? `${(timing.timeToInitialLoadMs / 1000).toFixed(2)}s` : '—'}</dd>
            <dt>Chunks / meshes</dt>
            <dd>
              {world?.loadedChunks ?? '—'} / {world?.totalMeshes ?? '—'}
            </dd>
            <dt>Heap (peak / final)</dt>
            <dd>
              {memory.peakUsedMB ? `${memory.peakUsedMB.toFixed(0)}` : '—'} /
              {memory.final?.usedJSHeapMB != null
                ? ` ${memory.final.usedJSHeapMB.toFixed(0)} MB`
                : ' n/a'}
            </dd>
            <dt>Device</dt>
            <dd>
              DPR {device.devicePixelRatio ?? '?'} · {device.hardwareConcurrency ?? '?'} cores ·{' '}
              {device.deviceMemoryGB != null ? `${device.deviceMemoryGB} GB` : 'mem ?'}
            </dd>
          </dl>
          <p className="benchmark-hud__note">
            Download the .txt and send it back for analysis. Also on <code>window.__lastBenchmark</code>.
          </p>
          <div className="benchmark-hud__actions">
            <button type="button" onClick={copyReport}>Copy</button>
            <button type="button" onClick={() => downloadReportTxt(report)}>Download .txt</button>
            <button type="button" className="benchmark-hud__primary" onClick={onDismiss}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  const sample = live?.lastSample;
  return (
    <div className="benchmark-hud benchmark-hud--live">
      <div className="benchmark-hud__card">
        <h2>Benchmark running</h2>
        <p>Camera locked south · no input</p>
        <dl className="benchmark-hud__grid">
          <dt>Elapsed</dt>
          <dd>{((live.elapsedMs || 0) / 1000).toFixed(1)}s / 60s</dd>
          <dt>FPS (1s)</dt>
          <dd>{(live.fps || 0).toFixed(1)}</dd>
          <dt>Chunks</dt>
          <dd>
            {sample?.loadedChunks ?? 0} loaded · {sample?.queuedChunks ?? 0} queued
          </dd>
          <dt>Meshes</dt>
          <dd>{sample?.totalMeshes ?? 0}</dd>
          <dt>Quiet</dt>
          <dd>
            {((live.quietMs || 0) / 1000).toFixed(1)}s / {((live.stableMsNeeded || 1500) / 1000).toFixed(1)}s
            {sample?.initialLoadComplete ? '' : ' (waiting for initial load)'}
          </dd>
          <dt>Heap</dt>
          <dd>
            {live.heap?.usedJSHeapMB != null
              ? `${live.heap.usedJSHeapMB.toFixed(0)} MB`
              : 'n/a'}
          </dd>
        </dl>
      </div>
    </div>
  );
}

export default BenchmarkHud;
