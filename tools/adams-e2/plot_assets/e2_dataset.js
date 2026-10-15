(function (root) {
  "use strict";

  const SCHEMA = "myadamsp2.adams-e2-support";
  const VERSION = 3;
  const GRAPH_SEMANTICS = "unlabeled-x0-x1-support";
  const MONOMIAL_LABEL = /^(?:1|(?:x_(?:[0-9]|\{[1-9][0-9]+\})(?:\^(?:[2-9]|\{[1-9][0-9]+\}))?)+)$/;
  const NODE_COLUMNS = [
    "basisIdDeltas",
    "stems",
    "filtrations",
    "monomialLabels",
    "layoutX",
    "layoutY",
    "radii",
  ];
  const PAYLOAD_FIELDS = new Set([
    "schema",
    "version",
    "graphSemantics",
    "key",
    "prime",
    "complex",
    "structure",
    "generatedAt",
    "generatedAtTimezone",
    ...NODE_COLUMNS,
    "edgeCounts",
    "edgeTargets",
  ]);

  function fail(message) {
    throw new Error("Invalid compact Adams E2 dataset: " + message);
  }

  function requireArray(payload, field) {
    const value = payload[field];
    if (!Array.isArray(value)) {
      fail(field + " must be an array");
    }
    return value;
  }

  function requireInteger(value, field) {
    if (!Number.isInteger(value)) {
      fail(field + " must be an integer");
    }
  }

  function requireSafeInteger(value, field) {
    if (!Number.isSafeInteger(value)) {
      fail(field + " must be a safe integer");
    }
  }

  function requireFiniteNumber(value, field) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(field + " must be a finite number");
    }
  }

  function validateNodeColumns(payload) {
    const columns = {};
    for (const field of NODE_COLUMNS) {
      columns[field] = requireArray(payload, field);
    }

    const count = columns.basisIdDeltas.length;
    for (const field of NODE_COLUMNS) {
      if (columns[field].length !== count) {
        fail(field + " length must equal basisIdDeltas length");
      }
    }

    const basisIds = [];
    let basisId = 0;
    for (let index = 0; index < count; index += 1) {
      const delta = columns.basisIdDeltas[index];
      requireSafeInteger(delta, "basisIdDeltas[" + index + "]");
      if (delta < 0 || (index > 0 && delta === 0)) {
        fail("basisIdDeltas must start nonnegative and have positive later deltas");
      }
      basisId += delta;
      requireSafeInteger(basisId, "cumulative basis ID");
      basisIds.push(basisId);
      requireInteger(columns.stems[index], "stems[" + index + "]");
      requireInteger(columns.filtrations[index], "filtrations[" + index + "]");
      requireFiniteNumber(columns.layoutX[index], "layoutX[" + index + "]");
      requireFiniteNumber(columns.layoutY[index], "layoutY[" + index + "]");
      requireFiniteNumber(columns.radii[index], "radii[" + index + "]");
      if (
        typeof columns.monomialLabels[index] !== "string" ||
        !MONOMIAL_LABEL.test(columns.monomialLabels[index])
      ) {
        fail("monomialLabels[" + index + "] must be a canonical display label");
      }
    }
    columns.basisIds = basisIds;
    return {columns, count};
  }

  function validateEdges(payload, count) {
    const edgeCounts = requireArray(payload, "edgeCounts");
    const edgeTargets = requireArray(payload, "edgeTargets");
    if (edgeCounts.length !== count) {
      fail("edgeCounts length must equal node count");
    }

    const edgeOffsets = [0];
    for (let index = 0; index < count; index += 1) {
      requireSafeInteger(edgeCounts[index], "edgeCounts[" + index + "]");
      if (edgeCounts[index] < 0) {
        fail("edgeCounts must be nonnegative");
      }
      const offset = edgeOffsets[index] + edgeCounts[index];
      requireSafeInteger(offset, "cumulative edge count");
      edgeOffsets.push(offset);
    }
    if (edgeOffsets[count] !== edgeTargets.length) {
      fail("edgeCounts total must equal edgeTargets length");
    }

    for (let source = 0; source < count; source += 1) {
      let previous = -1;
      for (
        let offset = edgeOffsets[source];
        offset < edgeOffsets[source + 1];
        offset += 1
      ) {
        const target = edgeTargets[offset];
        requireInteger(target, "edgeTargets[" + offset + "]");
        if (target < 0 || target >= count) {
          fail("edge target out of range at edgeTargets[" + offset + "]");
        }
        if (target === previous) {
          fail("duplicate target for source row " + source);
        }
        if (target < previous) {
          fail("targets for source row " + source + " must be sorted");
        }
        previous = target;
      }
    }
    return {edgeOffsets, edgeTargets};
  }

  const VIEW_COLUMNS = new WeakMap();

  class DatasetView {
    constructor(payload, columns, edgeOffsets, edgeTargets) {
      this.key = payload.key;
      this.prime = payload.prime;
      this.count = columns.basisIds.length;
      this.edgeCount = edgeTargets.length;
      VIEW_COLUMNS.set(this, {
        basisIds: columns.basisIds,
        monomialLabels: columns.monomialLabels,
        stems: columns.stems,
        filtrations: columns.filtrations,
        layoutX: columns.layoutX,
        layoutY: columns.layoutY,
        radii: columns.radii,
        edgeOffsets,
        edgeTargets,
      });
    }

    id(index) {
      return VIEW_COLUMNS.get(this).basisIds[index];
    }

    monomialLabel(index) {
      return VIEW_COLUMNS.get(this).monomialLabels[index];
    }

    degree(index) {
      const columns = VIEW_COLUMNS.get(this);
      return {
        stem: columns.stems[index],
        filtration: columns.filtrations[index],
      };
    }

    layout(index) {
      const columns = VIEW_COLUMNS.get(this);
      return {
        x: columns.layoutX[index],
        y: columns.layoutY[index],
        r: columns.radii[index],
      };
    }

    targets(index) {
      const columns = VIEW_COLUMNS.get(this);
      return columns.edgeTargets.slice(
        columns.edgeOffsets[index],
        columns.edgeOffsets[index + 1],
      );
    }

    forEachEdge(callback) {
      const columns = VIEW_COLUMNS.get(this);
      for (let source = 0; source < this.count; source += 1) {
        for (
          let offset = columns.edgeOffsets[source];
          offset < columns.edgeOffsets[source + 1];
          offset += 1
        ) {
          callback(source, columns.edgeTargets[offset]);
        }
      }
    }
  }

  function decodeCompactV3(payload) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      fail("payload must be an object");
    }
    for (const field of PAYLOAD_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) {
        fail("missing compact-v3 field " + field);
      }
    }
    for (const field of Object.keys(payload)) {
      if (!PAYLOAD_FIELDS.has(field)) {
        fail("unsupported compact-v3 field " + field);
      }
    }
    if (payload.schema !== SCHEMA) {
      fail("schema must be " + SCHEMA);
    }
    if (payload.version !== VERSION) {
      fail("version must be " + VERSION);
    }
    if (payload.graphSemantics !== GRAPH_SEMANTICS) {
      fail("graphSemantics must be " + GRAPH_SEMANTICS);
    }
    if (
      payload.complex !== "S0" ||
      payload.structure !== "ring" ||
      payload.generatedAtTimezone !== null
    ) {
      fail("unsupported compact-v3 fixed metadata");
    }
    if (typeof payload.generatedAt !== "string") {
      fail("generatedAt must be a string");
    }
    requireInteger(payload.prime, "prime");
    if (
      payload.prime <= 1 ||
      typeof payload.key !== "string" ||
      !/^p_(?:0|[1-9][0-9]*)_S0$/.test(payload.key) ||
      payload.key !== "p_" + payload.prime + "_S0"
    ) {
      fail("key must be canonical and match prime");
    }

    const nodeState = validateNodeColumns(payload);
    const edgeState = validateEdges(payload, nodeState.count);
    return new DatasetView(
      payload,
      nodeState.columns,
      edgeState.edgeOffsets,
      edgeState.edgeTargets,
    );
  }

  const api = {
    DatasetView,
    decodeCompactV3,
  };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.AdamsE2Dataset = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
