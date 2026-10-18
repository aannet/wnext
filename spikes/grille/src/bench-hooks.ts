// Instrumentation commune du second tour (A2, B2, B3). Jetable.
// frameWork = durée entre le début des callbacks rAF d'une frame et la première tâche suivante
// (MessageChannel posté depuis le rAF) : couvre JS rAF + style + layout + paint (enregistrement)
// + raster éventuel sur le thread principal. Ne couvre pas le raster/composite hors thread principal.
export function benchCore(scrollEl: HTMLElement, maxTop: number) {
  const frames: number[] = [], frameWork: number[] = [], longtasks: number[] = [];
  const eventDur: Record<string, number[]> = {};
  let rec = false, last = 0, tf = 0;
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { if (rec && tf) frameWork.push(performance.now() - tf); tf = 0; };
  const loop = (t: number) => {
    if (rec && last) frames.push(t - last);
    last = t;
    if (rec) { tf = performance.now(); ch.port2.postMessage(0); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => longtasks.push(e.duration))).observe({ entryTypes: ['longtask'] }); } catch {}
  try { new PerformanceObserver((l) => l.getEntries().forEach((e: any) => (eventDur[e.name] ??= []).push(e.duration))).observe({ type: 'event', durationThreshold: 16, buffered: true } as any); } catch {}
  return {
    frames, frameWork, longtasks, eventDur,
    startRec() { frames.length = 0; frameWork.length = 0; longtasks.length = 0; rec = true; last = 0; },
    stopRec() { rec = false; return { frames: [...frames], frameWork: [...frameWork], longtasks: [...longtasks] }; },
    scrollRun(ms: number, dxs: number, dys: number) {
      return new Promise<void>((res) => {
        const s = performance.now();
        const tick = (t: number) => {
          scrollEl.scrollLeft += dxs; scrollEl.scrollTop = (scrollEl.scrollTop + dys) % maxTop;
          if (scrollEl.scrollLeft >= scrollEl.scrollWidth - scrollEl.clientWidth - 5) scrollEl.scrollLeft = 0;
          if (t - s < ms) requestAnimationFrame(tick); else res();
        };
        requestAnimationFrame(tick);
      });
    },
  };
}

export function afterPaint(cb: () => void) { requestAnimationFrame(() => requestAnimationFrame(cb)); }
