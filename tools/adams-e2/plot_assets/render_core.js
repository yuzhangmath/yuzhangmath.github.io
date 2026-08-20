(function (root) {
  "use strict";

  class RenderGenerations {
    constructor() {
      this.current = 0;
      this.key = null;
    }

    begin(key) {
      this.current += 1;
      this.key = key;
      return this.current;
    }

    isActive(generation) {
      return generation === this.current;
    }
  }

  function createEdgeCursor() {
    return {source: 0, targetOffset: 0};
  }

  const CALLOUT_DIRECTIONS = [
    "northeast",
    "northwest",
    "southeast",
    "southwest",
    "east",
    "west",
    "north",
    "south",
  ];

  function calloutCandidate(anchor, labelSize, direction, gap) {
    const horizontal = anchor.radius + gap;
    const vertical = anchor.radius + gap;
    let left = anchor.x - labelSize.width / 2;
    let top = anchor.y - labelSize.height / 2;

    if (direction.includes("east")) left = anchor.x + horizontal;
    if (direction.includes("west")) left = anchor.x - horizontal - labelSize.width;
    if (direction.includes("north")) top = anchor.y - vertical - labelSize.height;
    if (direction.includes("south")) top = anchor.y + vertical;

    return {
      left,
      top,
      width: labelSize.width,
      height: labelSize.height,
      direction,
      gap,
      offsetX: left - anchor.x,
      offsetY: top - anchor.y,
    };
  }

  function clampRectIntoBounds(rect, bounds) {
    const maximumLeft = Math.max(bounds.left, bounds.right - rect.width);
    const maximumTop = Math.max(bounds.top, bounds.bottom - rect.height);
    const left = Math.min(Math.max(rect.left, bounds.left), maximumLeft);
    const top = Math.min(Math.max(rect.top, bounds.top), maximumTop);
    return Object.assign({}, rect, {left, top});
  }

  function compareScore(left, right) {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
    return 0;
  }

  function rectIntersectionArea(left, right) {
    const overlapWidth = Math.max(
      0,
      Math.min(left.left + left.width, right.right) -
        Math.max(left.left, right.left),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(left.top + left.height, right.bottom) -
        Math.max(left.top, right.top),
    );
    return overlapWidth * overlapHeight;
  }

  function expandRect(rect, padding) {
    return {
      left: rect.left - padding,
      top: rect.top - padding,
      width: rect.width + 2 * padding,
      height: rect.height + 2 * padding,
    };
  }

  function circleIntersectsRect(circle, rect) {
    const closestX = Math.min(
      Math.max(circle.x, rect.left),
      rect.left + rect.width,
    );
    const closestY = Math.min(
      Math.max(circle.y, rect.top),
      rect.top + rect.height,
    );
    return Math.hypot(circle.x - closestX, circle.y - closestY) <= circle.radius;
  }

  function pointInsideRect(point, rect) {
    return point.x >= rect.left && point.x <= rect.left + rect.width &&
      point.y >= rect.top && point.y <= rect.top + rect.height;
  }

  function crossProduct(first, second, third) {
    return (second.x - first.x) * (third.y - first.y) -
      (second.y - first.y) * (third.x - first.x);
  }

  function pointOnSegment(point, first, second) {
    return Math.abs(crossProduct(first, second, point)) <= Number.EPSILON &&
      point.x >= Math.min(first.x, second.x) &&
      point.x <= Math.max(first.x, second.x) &&
      point.y >= Math.min(first.y, second.y) &&
      point.y <= Math.max(first.y, second.y);
  }

  function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
    const firstSideStart = crossProduct(firstStart, firstEnd, secondStart);
    const firstSideEnd = crossProduct(firstStart, firstEnd, secondEnd);
    const secondSideStart = crossProduct(secondStart, secondEnd, firstStart);
    const secondSideEnd = crossProduct(secondStart, secondEnd, firstEnd);
    if (
      ((firstSideStart > 0 && firstSideEnd < 0) ||
        (firstSideStart < 0 && firstSideEnd > 0)) &&
      ((secondSideStart > 0 && secondSideEnd < 0) ||
        (secondSideStart < 0 && secondSideEnd > 0))
    ) {
      return true;
    }
    return (firstSideStart === 0 && pointOnSegment(secondStart, firstStart, firstEnd)) ||
      (firstSideEnd === 0 && pointOnSegment(secondEnd, firstStart, firstEnd)) ||
      (secondSideStart === 0 && pointOnSegment(firstStart, secondStart, secondEnd)) ||
      (secondSideEnd === 0 && pointOnSegment(firstEnd, secondStart, secondEnd));
  }

  function segmentIntersectsRect(segment, rect) {
    const start = {x: segment.x1, y: segment.y1};
    const end = {x: segment.x2, y: segment.y2};
    if (pointInsideRect(start, rect) || pointInsideRect(end, rect)) return true;
    const right = rect.left + rect.width;
    const bottom = rect.top + rect.height;
    const topLeft = {x: rect.left, y: rect.top};
    const topRight = {x: right, y: rect.top};
    const bottomRight = {x: right, y: bottom};
    const bottomLeft = {x: rect.left, y: bottom};
    return segmentsIntersect(start, end, topLeft, topRight) ||
      segmentsIntersect(start, end, topRight, bottomRight) ||
      segmentsIntersect(start, end, bottomRight, bottomLeft) ||
      segmentsIntersect(start, end, bottomLeft, topLeft);
  }

  function closestPointOnRect(point, rect) {
    return {
      x: Math.min(Math.max(point.x, rect.left), rect.left + rect.width),
      y: Math.min(Math.max(point.y, rect.top), rect.top + rect.height),
    };
  }

  function calloutLeader(anchor, rect) {
    const end = closestPointOnRect(anchor, rect);
    const deltaX = end.x - anchor.x;
    const deltaY = end.y - anchor.y;
    const length = Math.hypot(deltaX, deltaY);
    if (length === 0) {
      return {x1: anchor.x, y1: anchor.y, x2: end.x, y2: end.y};
    }
    return {
      x1: anchor.x + anchor.radius * deltaX / length,
      y1: anchor.y + anchor.radius * deltaY / length,
      x2: end.x,
      y2: end.y,
    };
  }

  function chooseCalloutPlacement(options) {
    const gaps = options.gaps || [10, 34, 64];
    const collisionPadding = options.collisionPadding === undefined ?
      4 : options.collisionPadding;
    let best = null;
    for (let distanceRank = 0; distanceRank < gaps.length; distanceRank += 1) {
      for (
        let directionRank = 0;
        directionRank < CALLOUT_DIRECTIONS.length;
        directionRank += 1
      ) {
        const natural = calloutCandidate(
          options.anchor,
          options.labelSize,
          CALLOUT_DIRECTIONS[directionRank],
          gaps[distanceRank],
        );
        const candidate = clampRectIntoBounds(natural, options.bounds);
        const clampDisplacement = Math.abs(candidate.left - natural.left) +
          Math.abs(candidate.top - natural.top);
        const paddedCandidate = expandRect(candidate, collisionPadding);
        const forbiddenIntersectionArea = (options.forbiddenRects || []).reduce(
          (area, obstacle) => area + rectIntersectionArea(paddedCandidate, obstacle),
          0,
        );
        const overlapsSelectedAnchor = Number(
          circleIntersectsRect(options.anchor, paddedCandidate),
        );
        const pointIntersections = (options.pointObstacles || []).reduce(
          (count, obstacle) => count + Number(
            circleIntersectsRect(obstacle, paddedCandidate),
          ),
          0,
        );
        const segmentIntersections = (options.segmentObstacles || []).reduce(
          (count, obstacle) => {
            const padding = Math.max(
              collisionPadding,
              2,
              obstacle.width / 2 + 2,
            );
            return count + Number(
              segmentIntersectsRect(obstacle, expandRect(candidate, padding)),
            );
          },
          0,
        );
        candidate.offsetX = candidate.left - options.anchor.x;
        candidate.offsetY = candidate.top - options.anchor.y;
        candidate.score = [
          overlapsSelectedAnchor,
          forbiddenIntersectionArea,
          pointIntersections,
          segmentIntersections,
          clampDisplacement,
          distanceRank,
          directionRank,
        ];
        if (best === null || compareScore(candidate.score, best.score) < 0) {
          best = candidate;
        }
      }
    }
    best.leader = calloutLeader(options.anchor, best);
    return best;
  }

  function advanceEdgeCursor(offsets, state) {
    while (
      state.source < offsets.length - 1 &&
      state.targetOffset >= offsets[state.source + 1]
    ) {
      state.source += 1;
    }
  }

  function takeEdgeBatch(offsets, targets, state, limit) {
    const batch = [];

    advanceEdgeCursor(offsets, state);
    while (batch.length < limit && !edgeCursorDone(offsets, state)) {
      if (state.targetOffset < offsets[state.source]) {
        state.targetOffset = offsets[state.source];
      }

      batch.push([state.source, targets[state.targetOffset]]);
      state.targetOffset += 1;
      advanceEdgeCursor(offsets, state);
    }

    return batch;
  }

  function edgeCursorDone(offsets, state) {
    return state.source >= offsets.length - 1;
  }

  function buildRenderEdgeArrays(view) {
    const edgeOffsets = [0];
    const edgeTargets = [];
    for (let source = 0; source < view.count; source += 1) {
      for (const target of view.targets(source)) {
        edgeTargets.push(target);
      }
      edgeOffsets.push(edgeTargets.length);
    }
    return {edgeOffsets, edgeTargets};
  }

  function targetsForSelection(view, datasetKey, index) {
    if (!view || view.key !== datasetKey || !Number.isInteger(index)) {
      return null;
    }
    if (index < 0 || index >= view.count) return null;
    return Array.from(view.targets(index));
  }

  function createSelectionLifecycle(options) {
    let selection = null;

    function clear() {
      const previous = selection;
      selection = null;
      options.clear(previous);
    }

    return {
      clear,
      current() {
        return selection;
      },
      select(view, datasetKey, index, node) {
        const targets = targetsForSelection(view, datasetKey, index);
        if (targets === null) return false;
        if (selection !== null) clear();
        selection = {
          datasetKey,
          index,
          node,
          basisId: view.id(index),
          label: view.monomialLabel(index),
          targets,
        };
        options.show(selection);
        return true;
      },
    };
  }

  function createPointerClickTracker() {
    const activePointers = new Set();
    let pointerDownOrigin = null;
    let didPointerDrag = false;

    function reset() {
      activePointers.clear();
      pointerDownOrigin = null;
      didPointerDrag = false;
    }

    return {
      cancel: reset,
      down(pointerId, x, y) {
        if (activePointers.size === 0) {
          pointerDownOrigin = {x, y};
          didPointerDrag = false;
        } else {
          didPointerDrag = true;
        }
        activePointers.add(pointerId);
      },
      move(pointerId, x, y) {
        if (!activePointers.has(pointerId) || pointerDownOrigin === null) return;
        if (Math.hypot(x - pointerDownOrigin.x, y - pointerDownOrigin.y) > 4) {
          didPointerDrag = true;
        }
      },
      up(pointerId) {
        if (!activePointers.delete(pointerId)) {
          return {removed: false, finished: false, activate: false};
        }
        const finished = activePointers.size === 0;
        const result = {
          removed: true,
          finished,
          activate: finished && !didPointerDrag,
        };
        if (finished) reset();
        return result;
      },
    };
  }

  function createPrimeRequestState(initialPrime) {
    let currentPrime = initialPrime;
    let requestedPrime = initialPrime;
    let nextRequestId = 0;
    let activeRequestId = 0;

    function start(prime) {
      requestedPrime = prime;
      activeRequestId = ++nextRequestId;
      return activeRequestId;
    }

    return {
      start,
      switchRequest(prime) {
        if (prime === requestedPrime) return null;
        return start(prime);
      },
      isActive(prime, requestId) {
        return requestedPrime === prime && activeRequestId === requestId;
      },
      commit(prime) {
        currentPrime = prime;
        requestedPrime = prime;
      },
      fail(prime) {
        if (requestedPrime === prime) {
          requestedPrime = currentPrime;
        }
      },
      requestedPrime() {
        return requestedPrime;
      },
    };
  }

  function createProgressivePlotController(options) {
    const generations = options.generations || new RenderGenerations();
    const schedule = options.requestAnimationFrame;
    const batchSize = options.batchSize;
    const edgeBatchSize = options.edgeBatchSize;

    function start(view, generation) {
      const activeGeneration = generation || generations.begin(view.key);
      if (options.clear) options.clear(view);

      const edges = buildRenderEdgeArrays(view);
      const state = {
        nodeIndex: 0,
        edgeCursor: createEdgeCursor(),
        edgeOffsets: edges.edgeOffsets,
        edgeTargets: edges.edgeTargets,
      };

      function step() {
        if (!generations.isActive(activeGeneration)) return;

        const nodes = [];
        while (state.nodeIndex < view.count && nodes.length < batchSize) {
          const index = state.nodeIndex;
          nodes.push({index, layout: view.layout(index)});
          state.nodeIndex += 1;
        }
        if (nodes.length > 0 && generations.isActive(activeGeneration)) {
          options.appendNodes(view, nodes, activeGeneration);
        }
        if (!generations.isActive(activeGeneration)) return;

        const edgePairs = takeEdgeBatch(
          state.edgeOffsets,
          state.edgeTargets,
          state.edgeCursor,
          edgeBatchSize,
        ).map(([source, target]) => ({
          source,
          target,
          sourceLayout: view.layout(source),
          targetLayout: view.layout(target),
        }));
        if (edgePairs.length > 0 && generations.isActive(activeGeneration)) {
          options.appendEdges(view, edgePairs, activeGeneration);
        }
        if (!generations.isActive(activeGeneration)) return;

        if (
          state.nodeIndex < view.count ||
          !edgeCursorDone(state.edgeOffsets, state.edgeCursor)
        ) {
          schedule(step);
        } else if (options.finalize) {
          options.finalize(view, activeGeneration);
        }
      }

      step();
      return activeGeneration;
    }

    return {start};
  }

  const COMPACT_DATA_BASE = "E2_js_data/compact/";

  function viewerDataFilePath(dataFile) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(dataFile)) return dataFile;
    if (dataFile.indexOf(COMPACT_DATA_BASE) === 0) return dataFile;
    return COMPACT_DATA_BASE + dataFile.replace(/^\.\//, "");
  }

  function viewerManifestWithDataBase(manifest) {
    if (!manifest || !manifest.datasets) return manifest;
    const adjusted = Object.assign({}, manifest, {datasets: {}});
    for (const key of Object.keys(manifest.datasets)) {
      const entry = manifest.datasets[key];
      adjusted.datasets[key] = Object.assign({}, entry, {
        dataFile: viewerDataFilePath(entry.dataFile),
      });
    }
    return adjusted;
  }

  function updateUrlParams(prime, browserWindow) {
    const url = new URL(browserWindow.location);
    url.searchParams.set("prime", prime);
    url.searchParams.delete("scale");
    url.searchParams.delete("x");
    url.searchParams.delete("y");
    browserWindow.history.replaceState(null, "", url);
  }

  function syncPrimeControls(prime, browserWindow, documentRoot) {
    updateUrlParams(prime, browserWindow);
    const select = documentRoot.getElementById("select_prime");
    if (select) {
      select.value = String(prime);
    }
  }

  const api = {
    RenderGenerations,
    chooseCalloutPlacement,
    createSelectionLifecycle,
    createPrimeRequestState,
    createProgressivePlotController,
    createPointerClickTracker,
    syncPrimeControls,
    targetsForSelection,
    updateUrlParams,
    viewerManifestWithDataBase,
  };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.AdamsE2RenderCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
