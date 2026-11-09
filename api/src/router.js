// Tiny path router: '/synagogues/:sid/minyanim/:id'. Numeric params are validated by the
// handlers; the router only matches and extracts.

export class Router {
  routes = [];

  add(method, pattern, handler, options = {}) {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:([a-z_]+)/gi, (_, key) => (keys.push(key), '([^/]+)')) + '/?$'
    );
    this.routes.push({ method, regex, keys, handler, options });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  /** @returns {{route, params} | {allowed: string[]} | null} */
  match(method, path) {
    const allowed = [];
    for (const route of this.routes) {
      const m = route.regex.exec(path);
      if (!m) continue;
      if (route.method !== method) {
        allowed.push(route.method);
        continue;
      }
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return { route, params };
    }
    return allowed.length ? { allowed } : null;
  }
}
