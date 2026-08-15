function typeError(path, message) {
  return new TypeError(`${path} ${message}`);
}

/** Validate and recursively clone a value that JSON can represent losslessly. */
export function cloneJsonValue(value, path = "JSON value", ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") {
    throw typeError(path, "contains a value JSON cannot preserve.");
  }
  if (ancestors.has(value)) throw typeError(path, "contains a cycle.");

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw typeError(path, "contains a non-plain object.");
  }

  ancestors.add(value);
  let clone;
  if (isArray) {
    clone = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw typeError(`${path}[${index}]`, "is missing.");
      clone.push(cloneJsonValue(value[index], `${path}[${index}]`, ancestors));
    }
    if (
      Object.keys(value).some((key) => {
        const index = Number(key);
        return !Number.isInteger(index) || index < 0 || String(index) !== key || index >= value.length;
      })
    ) {
      throw typeError(path, "contains array properties JSON cannot preserve.");
    }
  } else {
    clone = {};
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(clone, key, {
        value: cloneJsonValue(child, `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  ancestors.delete(value);
  return clone;
}
