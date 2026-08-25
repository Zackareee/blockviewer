import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  BenchmarkRunner,
  BENCHMARK_LOCK_YAW,
  BENCHMARK_LOCK_PITCH,
} from '../utils/BenchmarkRunner';

/**
 * In-canvas controller: locks look direction, samples streamer/manager each frame,
 * ends on stable or 60s.
 */
export function BenchmarkController({
  enabled = false,
  spectatorRef = null,
  streamerRef = null,
  managerRef = null,
  renderDistance = 3,
  chunkLoadingSpeed = 1,
  targetResolution = 'native',
  onLive = null,
  onComplete = null,
}) {
  const runnerRef = useRef(null);
  const startedRef = useRef(false);
  const doneRef = useRef(false);
  const liveThrottleRef = useRef(0);
  const { gl, camera } = useThree();

  useEffect(() => {
    if (!enabled) {
      runnerRef.current?.stop('cancelled');
      runnerRef.current = null;
      startedRef.current = false;
      doneRef.current = false;
      return undefined;
    }

    startedRef.current = false;
    doneRef.current = false;
    runnerRef.current = new BenchmarkRunner();

    return () => {
      const spectator = spectatorRef?.current;
      runnerRef.current?.stop('cancelled');
      runnerRef.current = null;
      spectator?.setInputLocked?.(false);
    };
  }, [enabled, spectatorRef]);

  useFrame(() => {
    if (!enabled || doneRef.current) return;

    const streamer = streamerRef?.current || (typeof window !== 'undefined' ? window.__chunkStreamer : null);
    const manager = managerRef?.current;
    const scm = streamer?.superChunkManager || manager?.superChunkManager;

    if (!startedRef.current) {
      if (!streamer || !spectatorRef?.current) return;

      spectatorRef.current.teleport?.(
        camera.position.x,
        camera.position.y,
        camera.position.z,
        BENCHMARK_LOCK_YAW,
        BENCHMARK_LOCK_PITCH
      );
      spectatorRef.current.setInputLocked?.(true, BENCHMARK_LOCK_YAW, BENCHMARK_LOCK_PITCH);

      runnerRef.current?.start();
      startedRef.current = true;
      console.log('[Benchmark] Started — locked look south, measuring until stable or 60s');
    }

    const scmStats = scm?.getStats?.() || {};
    const snap = {
      loadedChunks: streamer?.loadedChunks?.size ?? 0,
      queuedChunks: streamer?.loadQueue?.size ?? 0,
      isProcessing: !!streamer?.isProcessing,
      initialLoadComplete: !!streamer?.initialLoadComplete,
      totalMeshes: scmStats.totalMeshes ?? 0,
      superChunkCount: scmStats.superChunkCount ?? 0,
      dirtyCount: (scmStats.dirtyCount ?? 0) + (scmStats.boundaryDirtyCount ?? 0),
      pendingWork: !!scm?.hasPendingWork?.(),
      stage: streamer?.initialLoadComplete ? 'streaming' : 'loading',
      renderDistance,
      chunkLoadingSpeed,
      dpr: gl.getPixelRatio?.() ?? null,
      targetResolution,
    };

    const report = runnerRef.current?.observe(snap);
    const now = performance.now();
    if (onLive && now - liveThrottleRef.current > 200) {
      liveThrottleRef.current = now;
      onLive(runnerRef.current.getLive());
    }

    if (report) {
      doneRef.current = true;
      spectatorRef.current?.setInputLocked?.(false);
      console.log('[Benchmark] Complete:', report.endReason, report);
      onComplete?.(report);
      if (typeof window !== 'undefined') {
        window.__lastBenchmark = report;
      }
    }
  });

  return null;
}

export default BenchmarkController;
