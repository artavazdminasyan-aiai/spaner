/* Runs the Spaner AI off the main thread. */
/* global importScripts, SpanerAI */
importScripts('engine.js', 'ai.js');

self.onmessage = function (e) {
  const d = e.data;
  let move = null;
  try {
    move = SpanerAI.think(d.state, { level: d.level, frac: d.frac });
  } catch (err) {
    move = null;
  }
  self.postMessage({ id: d.id, move });
};
