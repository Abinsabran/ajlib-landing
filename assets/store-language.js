/* Presentation-only localization. Cart identifiers and customer form values stay unchanged. */
(() => {
  'use strict';
  const storageKey = 'ajlibLanguage';
  const catalog = window.AJLIB_TRANSLATIONS || { exact: {}, patterns: [] };
  const records = new WeakMap();
  const excluded = 'script,style,textarea,[translate="no"],[data-no-i18n]';
  // 'label' covers the delivery-country <optgroup> headings.
  const attributes = ['placeholder', 'aria-label', 'title', 'alt', 'label'];
  let language = 'ar';
  try {
    const requested = new URLSearchParams(location.search).get('lang');
    const saved = localStorage.getItem(storageKey);
    language = (requested || saved) === 'en' ? 'en' : 'ar';
  } catch (_) { /* Arabic remains available if storage is blocked. */ }

  function english(value) {
    const match = String(value).match(/^(\s*)([\s\S]*?)(\s*)$/);
    const [, before, source, after] = match;
    let result = catalog.exact[source];
    if (result === undefined) {
      for (const [pattern, replacement] of catalog.patterns || []) {
        pattern.lastIndex = 0;
        if (pattern.test(source)) {
          pattern.lastIndex = 0;
          result = source.replace(pattern, replacement);
          break;
        }
      }
    }
    return before + (result === undefined ? source : result) + after;
  }

  function translate(value) { return language === 'en' ? english(value) : String(value); }

  function translateSlot(node, key, read, write) {
    const current = read();
    if (!current) return;
    let slots = records.get(node);
    if (!slots) records.set(node, slots = {});
    let slot = slots[key];
    if (!slot || current !== slot.rendered) slot = slots[key] = { source: current, rendered: current };
    const next = translate(slot.source);
    slot.rendered = next;
    if (current !== next) write(next);
  }

  function process(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      if (root.parentElement && !root.parentElement.closest(excluded)) {
        translateSlot(root, 'text', () => root.nodeValue, value => { root.nodeValue = value; });
      }
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || root.closest(excluded)) return;
    if (root.matches('time[datetime]')) {
      const date = new Date(root.getAttribute('datetime'));
      if (!Number.isNaN(date.getTime())) {
        const locale = language === 'en' ? 'en-AE' : 'ar-AE';
        const value = root.getAttribute('data-date-format') === 'date' ? date.toLocaleDateString(locale) : date.toLocaleString(locale);
        if (root.textContent !== value) root.textContent = value;
      }
      return;
    }
    if (root.tagName === 'OPTION' && !root.hasAttribute('value')) root.setAttribute('value', root.value);
    for (const attr of attributes) {
      if (root.hasAttribute(attr)) translateSlot(root, attr, () => root.getAttribute(attr), value => root.setAttribute(attr, value));
    }
    if (root.matches('meta[name="description"]')) {
      translateSlot(root, 'content', () => root.content, value => { root.content = value; });
    }
    for (const child of root.childNodes) process(child);
    if (root.matches('select.country-select')) {
      const selectedValue = root.value;
      const options = [...root.options];
      const sorted = [...options].sort((a, b) => {
        if (!a.value) return -1;
        if (!b.value) return 1;
        return a.textContent.localeCompare(b.textContent, language);
      });
      if (sorted.some((option, index) => option !== options[index])) {
        root.append(...sorted);
        root.value = selectedValue;
      }
    }
  }

  const observer = new MutationObserver(changes => {
    observer.disconnect();
    for (const change of changes) {
      if (change.type === 'childList') for (const node of change.addedNodes) process(node);
      else process(change.target);
    }
    observe();
  });
  function observe() {
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: attributes.concat('content')
    });
  }

  function apply(next, persist = true) {
    language = next === 'en' ? 'en' : 'ar';
    observer.disconnect();
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'en' ? 'ltr' : 'rtl';
    process(document.documentElement);
    const toggle = document.getElementById('languageToggle');
    if (toggle) {
      toggle.textContent = language === 'en' ? 'العربية' : 'English';
      toggle.lang = language === 'en' ? 'ar' : 'en';
      toggle.setAttribute('aria-label', language === 'en' ? 'التبديل إلى العربية' : 'Switch to English');
      toggle.onclick = () => apply(language === 'en' ? 'ar' : 'en');
    }
    if (persist) {
      try { localStorage.setItem(storageKey, language); } catch (_) { /* Session-only choice. */ }
      const url = new URL(location.href);
      url.searchParams.set('lang', language);
      history.replaceState(history.state, '', url);
    }
    observe();
  }

  window.AJLIB_LANGUAGE = { text: translate, apply, get current() { return language; } };
  window.addEventListener('storage', event => {
    if (event.key === storageKey) apply(event.newValue, false);
  });
  apply(language, false);
  try { localStorage.setItem(storageKey, language); } catch (_) { /* Optional preference only. */ }
})();
