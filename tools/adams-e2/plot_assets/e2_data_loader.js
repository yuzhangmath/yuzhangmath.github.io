(function (root) {
  "use strict";

  const REGISTRY_NAME = "__MYADAMSP2_E2_V2__";
  const MANIFEST_NAME = "__MYADAMSP2_E2_MANIFEST_V2__";
  const MANIFEST_SCHEMA = "myadamsp2.adams-e2-manifest";
  const MANIFEST_FIELDS = new Set([
    "schema",
    "version",
    "graphSemantics",
    "datasets",
  ]);
  const GRAPH_SEMANTICS = "unlabeled-x0-x1-support";

  const datasetApi = (
    typeof module === "object" && module.exports
      ? require("./e2_dataset.js")
      : root.AdamsE2Dataset
  );

  function defaultScriptInjector(url) {
    if (!root.document || typeof root.document.createElement !== "function") {
      return Promise.reject(new Error("document is required to load " + url));
    }
    return new Promise((resolve, reject) => {
      const script = root.document.createElement("script");
      script.src = url;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("failed to load " + url));
      root.document.head.appendChild(script);
    });
  }

  function defaultScriptPrefetcher(url) {
    if (!root.document || typeof root.document.createElement !== "function") {
      return;
    }
    const link = root.document.createElement("link");
    link.rel = "prefetch";
    link.as = "script";
    link.href = url;
    root.document.head.appendChild(link);
  }

  function resolveDataUrl(dataFile) {
    if (root.document && root.document.baseURI) {
      return new URL(dataFile, root.document.baseURI).href;
    }
    return dataFile;
  }

  function validateManifest(manifest) {
    if (
      manifest === null ||
      typeof manifest !== "object" ||
      Array.isArray(manifest)
    ) {
      throw new Error("compact E2 manifest is missing");
    }
    const fields = Object.keys(manifest);
    if (
      fields.length !== MANIFEST_FIELDS.size ||
      fields.some((field) => !MANIFEST_FIELDS.has(field))
    ) {
      throw new Error("unsupported compact E2 manifest fields");
    }
    if (manifest.schema !== MANIFEST_SCHEMA) {
      throw new Error("unsupported compact E2 manifest schema");
    }
    if (manifest.version !== 2) {
      throw new Error("unsupported compact E2 manifest version");
    }
    if (manifest.graphSemantics !== GRAPH_SEMANTICS) {
      throw new Error("unsupported compact E2 graph semantics");
    }
    if (
      manifest.datasets === null ||
      typeof manifest.datasets !== "object" ||
      Array.isArray(manifest.datasets)
    ) {
      throw new Error("compact E2 manifest datasets must be an object");
    }
  }

  function findEntryByPrime(manifest, prime) {
    for (const key of Object.keys(manifest.datasets)) {
      const entry = manifest.datasets[key];
      if (entry && entry.prime === prime) {
        return entry;
      }
    }
    throw new Error("No compact E2 dataset is available for prime " + prime);
  }

  class E2DataLoader {
    constructor(manifest, injectScript, prefetchScript) {
      this.manifest = manifest || root[MANIFEST_NAME];
      validateManifest(this.manifest);
      this.injectScript = injectScript || defaultScriptInjector;
      this.prefetchScript = prefetchScript || defaultScriptPrefetcher;
      this.promises = new Map();
      this.prefetched = new Set();
    }

    prefetch(prime) {
      const entry = findEntryByPrime(this.manifest, prime);
      if (this.prefetched.has(entry.key) || this.promises.has(entry.key)) return;
      this.prefetchScript(resolveDataUrl(entry.dataFile));
      this.prefetched.add(entry.key);
    }

    prefetchAllExcept(activePrime) {
      for (const entry of Object.values(this.manifest.datasets)) {
        if (entry.prime !== activePrime) this.prefetch(entry.prime);
      }
    }

    load(prime) {
      let entry;
      try {
        entry = findEntryByPrime(this.manifest, prime);
      } catch (error) {
        return Promise.reject(error);
      }
      if (!this.promises.has(entry.key)) {
        const promise = this._loadEntry(entry).catch((error) => {
          this.promises.delete(entry.key);
          throw error;
        });
        this.promises.set(entry.key, promise);
      }
      return this.promises.get(entry.key);
    }

    async _loadEntry(entry) {
      const registry = root[REGISTRY_NAME];
      if (!registry || !Object.prototype.hasOwnProperty.call(registry, entry.key)) {
        await this.injectScript(resolveDataUrl(entry.dataFile));
      }

      const updatedRegistry = root[REGISTRY_NAME];
      if (
        !updatedRegistry ||
        !Object.prototype.hasOwnProperty.call(updatedRegistry, entry.key)
      ) {
        throw new Error("compact E2 dataset " + entry.key + " was not registered");
      }

      const payload = updatedRegistry[entry.key];
      delete updatedRegistry[entry.key];
      const view = datasetApi.decodeCompactV2(payload);
      if (view.key !== entry.key) {
        throw new Error("compact E2 dataset key mismatch for " + entry.key);
      }
      if (view.prime !== entry.prime) {
        throw new Error("compact E2 dataset prime mismatch for " + entry.key);
      }
      if (
        Number.isInteger(entry.nodeCount) &&
        view.count !== entry.nodeCount
      ) {
        throw new Error("compact E2 node count mismatch for " + entry.key);
      }
      if (
        Number.isInteger(entry.edgeCount) &&
        view.edgeCount !== entry.edgeCount
      ) {
        throw new Error("compact E2 edge count mismatch for " + entry.key);
      }
      return view;
    }
  }

  const api = {
    E2DataLoader,
    defaultScriptInjector,
    defaultScriptPrefetcher,
  };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.AdamsE2DataLoader = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
