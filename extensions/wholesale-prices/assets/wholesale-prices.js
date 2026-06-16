// B2B Wholesale Prices — multi-theme storefront script
// Prices fetched via Shopify App Proxy (/a/b2b-wholesale/prices).
// Shopify injects logged_in_customer_id server-side — no spoofing possible.

(function () {
  console.log('[B2B] script executing');

  var root = document.getElementById('b2b-wholesale-root');
  if (!root) {
    console.log('[B2B] STOP: #b2b-wholesale-root not found — enable the app embed in your theme editor');
    return;
  }

  var customerId   = root.dataset.customerId   || '';
  var currencyCode = (root.dataset.currency    || 'USD').toUpperCase();
  var shopLocale   = document.documentElement.lang || navigator.language || 'en';
  var themeName    = root.dataset.theme || 'dawn';

  console.log('[B2B] theme=' + themeName + ' | customer=' + (customerId || '(guest)') + ' | currency=' + currencyCode);

  // ─────────────────────────────────────────────────────────────────────────────
  // THEME REGISTRY
  // Each entry defines how to find and manipulate price elements.
  // To add a new theme: copy any entry, change the selectors, add the key below.
  //
  // Properties:
  //   priceRootSel   — CSS selector that matches ONE element per product price widget
  //   preHideCSS     — CSS injected before fetch to prevent flash of original prices
  //   regularSel     — selector (within price root) for the "regular price" section
  //   saleSel        — selector (within price root) for the "sale price" section
  //   regularAmtSel  — selector for the text node with the regular price number
  //   saleAmtSel     — selector for the text node with the sale price number
  //   compareAmtSel  — selector for the compare-at (strikethrough) element
  //   hiddenClass    — CSS class that visually hides an element; null = display:none
  // ─────────────────────────────────────────────────────────────────────────────
  var THEMES = {

    // ── Dawn and all modern free 2.0 themes ────────────────────────────────────
    // Dawn, Craft, Refresh, Sense, Taste, Crave, Studio, Colorblock, Context
    dawn: {
      priceRootSel:  'product-price',
      preHideCSS:    'product-price{opacity:0!important;transition:none!important}',
      regularSel:    '.price__regular',
      saleSel:       '.price__sale',
      regularAmtSel: '.price-item--regular, .price',
      saleAmtSel:    '.price-item--sale',
      compareAmtSel: '.compare-at-price',
      hiddenClass:   'price__hidden',
    },

    // ── Legacy free themes ─────────────────────────────────────────────────────
    // Debut, Brooklyn, Minimal, Simple, Narrative, Boundless, Venture, Supply
    debut: {
      priceRootSel:  '.price--main, .product__price, .ProductPrice, [data-product-price]',
      preHideCSS:    '.price--main,.product__price,.ProductPrice{opacity:0!important;transition:none!important}',
      regularSel:    null,
      saleSel:       null,
      regularAmtSel: '.money',
      saleAmtSel:    '.money',
      compareAmtSel: '.compare-at-price, .was-price, del.money, s.money',
      hiddenClass:   null,
    },

    // ── Archetype Themes ───────────────────────────────────────────────────────
    // Impulse, Impact, Motion, Streamline
    impulse: {
      priceRootSel:  '.price-wrapper, .product-item__info .price, .product__info .price',
      preHideCSS:    '.price-wrapper,.product-item__info .price{opacity:0!important;transition:none!important}',
      regularSel:    '.price__regular, .price:not(.price--sold-out)',
      saleSel:       '.price__sale',
      regularAmtSel: '.price-item--regular, .price-item',
      saleAmtSel:    '.price-item--sale, .price-item',
      compareAmtSel: '.price-item--compare, del',
      hiddenClass:   'price__hidden',
    },

    // ── Out of the Sandbox ─────────────────────────────────────────────────────
    // Turbo, Flex, Expanse, Retina
    turbo: {
      priceRootSel:  '.product__price, .product-item__price',
      preHideCSS:    '.product__price,.product-item__price{opacity:0!important;transition:none!important}',
      regularSel:    null,
      saleSel:       null,
      regularAmtSel: '.theme-money, .money',
      saleAmtSel:    '.theme-money, .money',
      compareAmtSel: '.compare-price del, del.theme-money, s.theme-money, .compare-at-price',
      hiddenClass:   null,
    },

    // ── Maestrooo — Prestige ───────────────────────────────────────────────────
    prestige: {
      priceRootSel:  '.price-list, .price-list--product',
      preHideCSS:    '.price-list{opacity:0!important;transition:none!important}',
      regularSel:    null,
      saleSel:       null,
      regularAmtSel: '.price:not(.price--compare) .money, .price--regular .money',
      saleAmtSel:    '.price--sale .money, .price:not(.price--compare) .money',
      compareAmtSel: '.price--compare .money',
      hiddenClass:   null,
    },

    // ── Invisible Themes — Broadcast ──────────────────────────────────────────
    broadcast: {
      priceRootSel:  '.price-area, .product-block--price',
      preHideCSS:    '.price-area{opacity:0!important;transition:none!important}',
      regularSel:    '.price-area__current',
      saleSel:       '.price-area__current',
      regularAmtSel: '.price-area__current .money',
      saleAmtSel:    '.price-area__current .money',
      compareAmtSel: '.price-area__was .money, .was-price .money',
      hiddenClass:   null,
    },

    // ── Groupthought / Pixel Union ─────────────────────────────────────────────
    // Pipeline, Startup, Venue, Handy, Warehouse
    pipeline: {
      priceRootSel:  '.product-price, .price-block',
      preHideCSS:    '.product-price,.price-block{opacity:0!important;transition:none!important}',
      regularSel:    null,
      saleSel:       null,
      regularAmtSel: '.product-price__amount--regular .money, .money',
      saleAmtSel:    '.product-price__amount--sale .money, .money',
      compareAmtSel: '.product-price__amount--compare .money, del .money, s .money',
      hiddenClass:   null,
    },

    // ── Debutify / common page-builder themes ─────────────────────────────────
    debutify: {
      priceRootSel:  '.product__price-wrapper, .dbt-price-wrapper, .price',
      preHideCSS:    '.product__price-wrapper,.dbt-price-wrapper{opacity:0!important;transition:none!important}',
      regularSel:    null,
      saleSel:       null,
      regularAmtSel: '.price__current .money, .money',
      saleAmtSel:    '.price__sale .money, .money',
      compareAmtSel: '.price__compare .money, del.money, s.money',
      hiddenClass:   null,
    },

    // ── Pursuit ────────────────────────────────────────────────────────────────
    // Uses Dawn-style .price__regular / .price__sale sections inside a plain
    // .price div (product page wraps them in .price__pricing-group; listing
    // pages use .price.price--listing — querySelector finds both via descent).
    // Compare-at is an <s> element with class price-item--regular inside
    // .price__sale, and .price__compare on listing pages.
    pursuit: {
      priceRootSel:  '.price',
      preHideCSS:    '.price .price__regular,.price .price__sale{opacity:0!important;transition:none!important}',
      regularSel:    '.price__regular',
      saleSel:       '.price__sale',
      regularAmtSel: '.price-item--regular',
      saleAmtSel:    '.price-item--sale',
      compareAmtSel: 's.price-item--regular, s.price-item, .price__compare s',
      hiddenClass:   null,
    },
  };

  // ── Build effective theme config ─────────────────────────────────────────────
  var T; // active theme config
  if (themeName === 'custom') {
    T = {
      priceRootSel:  root.dataset.priceRoot  || 'product-price',
      preHideCSS:    (root.dataset.priceRoot || 'product-price') + '{opacity:0!important}',
      regularSel:    root.dataset.regularSel  || null,
      saleSel:       root.dataset.saleSel     || null,
      regularAmtSel: root.dataset.amountSel   || '.money',
      saleAmtSel:    root.dataset.amountSel   || '.money',
      compareAmtSel: root.dataset.compareSel  || null,
      hiddenClass:   root.dataset.hiddenClass || null,
    };
  } else {
    T = THEMES[themeName] || THEMES.dawn;
  }

  // ── Pre-hide prices for logged-in customers (prevent FOUC) ──────────────────
  var priceHideStyle = null;
  if (customerId) {
    priceHideStyle = document.createElement('style');
    priceHideStyle.textContent = T.preHideCSS;
    document.head.appendChild(priceHideStyle);
    setTimeout(revealPrices, 2000); // failsafe reveal
  }

  function revealPrices() {
    if (priceHideStyle && priceHideStyle.parentNode) {
      priceHideStyle.parentNode.removeChild(priceHideStyle);
      priceHideStyle = null;
    }
  }

  // numericVariantId → price entry from proxy
  var priceMap     = {};
  var fetchedIds   = new Set();
  var priceDisplay = 'REPLACED';

  // Catalog-level global rules (applied to any product not in priceMap)
  var fixedOffVariants         = {};   // variantId → { fixedOff, priceDisplay }
  var globalFixedOff           = 0;
  var globalFixedOffDisplay    = 'REPLACED';
  var globalFixedPrice         = 0;
  var globalFixedPriceDisplay  = 'REPLACED';

  var minimumOrderCents           = 0;
  var minimumOrderFetched         = false;
  var minimumOrderMessageTemplate = '';

  // ── Debounced batch fetch ────────────────────────────────────────────────────
  var fetchTimer    = null;
  var fetchInFlight = false;

  function scheduleFetch(delayMs) {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(executeFetch, delayMs != null ? delayMs : 120);
  }

  function executeFetch() {
    if (fetchInFlight) {
      fetchTimer = setTimeout(executeFetch, 200);
      return;
    }
    var ids    = getVisibleVariantIds();
    var newIds = ids.filter(function (id) { return !fetchedIds.has(id); });

    if (!newIds.length && minimumOrderFetched) { applyAllWholesalePrices(); return; }

    newIds.forEach(function (id) { fetchedIds.add(id); });

    var params = new URLSearchParams();
    if (newIds.length) params.set('v', newIds.join(','));

    console.log('[B2B] fetching prices for', newIds.length, 'variant(s)');
    fetchInFlight = true;
    fetch('/a/b2b-wholesale/prices?' + params.toString())
      .then(function (res) {
        console.log('[B2B] status:', res.status);
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        fetchInFlight = false;
        if (!data) { revealPrices(); return; }

        if (!minimumOrderFetched && customerId) {
          minimumOrderCents           = data.minimumOrderCents || 0;
          minimumOrderMessageTemplate = data.minimumOrderMessage || '';
          minimumOrderFetched         = true;
          enforceMinimumOrder();
        }

        if (data.priceDisplay) priceDisplay = data.priceDisplay;

        // Catalog-level global rules
        if (data.fixedOffVariants) {
          Object.assign(fixedOffVariants, data.fixedOffVariants);
        }
        if (data.fixedOff > 0) {
          globalFixedOff        = data.fixedOff;
          globalFixedOffDisplay = data.fixedOffPriceDisplay || 'REPLACED';
        }
        if (data.fixedPrice > 0) {
          globalFixedPrice        = data.fixedPrice;
          globalFixedPriceDisplay = data.fixedPricePriceDisplay || 'REPLACED';
        }

        if (Array.isArray(data.products)) {
          var added = 0;
          data.products.forEach(function (p) {
            if (!p.variantId || !(p.wholesalePriceCents > 0)) return;
            var numId = p.variantId.includes('/')
              ? p.variantId.split('/').pop()
              : p.variantId;
            priceMap[numId] = p;
            added++;
          });
          console.log('[B2B] added', added, 'price entries | total in map:', Object.keys(priceMap).length, '| fixedOff:', globalFixedOff, '| fixedPrice:', globalFixedPrice);
        }

        revealPrices();
        applyAllWholesalePrices();
      })
      .catch(function (err) {
        fetchInFlight = false;
        console.warn('[B2B] fetch error:', err);
        revealPrices();
      });
  }

  // ── Collect all visible variant IDs ─────────────────────────────────────────
  function getVisibleVariantIds() {
    var ids = new Set();
    // Every input[name="id"] on the page (covers product cards in all themes)
    document.querySelectorAll('input[name="id"]').forEach(function (inp) {
      if (inp.value) ids.add(String(inp.value));
    });
    // Select elements (some themes use <select name="id">)
    document.querySelectorAll('select[name="id"]').forEach(function (sel) {
      if (sel.value) ids.add(String(sel.value));
    });
    // data-variant-id attributes (used by some themes on cards)
    document.querySelectorAll('[data-variant-id]').forEach(function (el) {
      var v = el.dataset.variantId;
      if (v) ids.add(String(v));
    });
    return Array.from(ids);
  }

  // ── Format cents → locale-aware currency string ──────────────────────────────
  function fmt(cents) {
    try {
      return new Intl.NumberFormat(shopLocale, {
        style: 'currency', currency: currencyCode,
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      }).format(cents / 100);
    } catch (e) {
      return currencyCode + ' ' + (cents / 100).toFixed(2);
    }
  }

  // ── Minimum order enforcement ────────────────────────────────────────────────
  function enforceMinimumOrder() {
    if (!minimumOrderCents) { enableCheckout(); removeMinimumMessage(); return; }
    fetch('/cart.js')
      .then(function (res) { return res.json(); })
      .then(function (cart) {
        var sub = cart.items_subtotal_price || 0;
        if (sub < minimumOrderCents) { disableCheckout(); showMinimumMessage(minimumOrderCents, sub); }
        else                         { enableCheckout();  removeMinimumMessage(); }
      })
      .catch(function (e) { console.warn('[B2B] cart.js error:', e); });
  }

  function disableCheckout() {
    document.querySelectorAll([
      'button[name="checkout"]', 'input[name="checkout"]', 'a[href="/checkout"]',
      '.cart__checkout-button', '.cart__ctas button[type="submit"]',
      '[data-cart-checkout]', '.cart-drawer__footer button[type="submit"]',
      'cart-items button[type="submit"]',
    ].join(',')).forEach(function (btn) {
      btn.setAttribute('disabled', 'disabled');
      btn.dataset.b2bDisabled = '1';
    });
  }

  function enableCheckout() {
    document.querySelectorAll('[data-b2bDisabled]').forEach(function (btn) {
      btn.removeAttribute('disabled');
      delete btn.dataset.b2bDisabled;
    });
  }

  function showMinimumMessage(minCents, currentCents) {
    removeMinimumMessage();
    var msg = document.createElement('div');
    msg.id  = 'b2b-minimum-order-msg';
    msg.style.cssText = 'background:#fff3cd;color:#856404;border:1px solid #ffc107;padding:12px 16px;border-radius:4px;margin:12px 0;font-size:0.95em;line-height:1.4;';
    var needed   = fmt(minCents - currentCents);
    var template = minimumOrderMessageTemplate || 'Minimum order is {min}. Add {required} more to proceed.';
    msg.textContent = template
      .replace(/\{min\}/g,      fmt(minCents))
      .replace(/\{required\}/g, needed)
      .replace(/\{needed\}/g,   needed);
    var anchor =
      document.querySelector('.cart__footer') ||
      document.querySelector('.cart-drawer__footer') ||
      document.querySelector('[class*="cart-footer"]') ||
      document.querySelector('cart-items');
    if (anchor) {
      anchor.insertBefore(msg, anchor.firstChild);
    } else {
      var btn = document.querySelector('button[name="checkout"], a[href="/checkout"]');
      if (btn && btn.parentNode) btn.parentNode.insertBefore(msg, btn);
    }
  }

  function removeMinimumMessage() {
    var el = document.getElementById('b2b-minimum-order-msg');
    if (el) el.remove();
  }

  // ── Get variant ID for a given price root element ────────────────────────────
  // Walks up the DOM looking for input[name="id"] — works for every theme's card
  // structure (product-card custom element, div.product-item, li.grid__item, etc.)
  function getVariantIdFor(priceRoot) {
    var el      = priceRoot;
    var maxUp   = 10;
    while (el && maxUp-- > 0) {
      el = el.parentElement;
      if (!el) break;
      var tag = el.tagName.toLowerCase();
      if (tag === 'body' || tag === 'main' || tag === 'html') break;
      var inp = el.querySelector('input[name="id"]');
      if (inp && inp.value) return String(inp.value);
      var sel = el.querySelector('select[name="id"]');
      if (sel && sel.value) return String(sel.value);
      var dv = el.dataset && el.dataset.variantId;
      if (dv) return String(dv);
    }
    // Fall back to the main product form (product page context)
    var form = document.querySelector('form[action*="/cart/add"]');
    if (!form) return null;
    var inp2 = form.querySelector('input[name="id"]') || form.querySelector('select[name="id"]');
    return inp2 ? String(inp2.value) : null;
  }

  // ── Get the inner container div from a price root (theme-aware) ──────────────
  function getContainer(priceRoot) {
    if (themeName === 'dawn' || THEMES[themeName] === THEMES.dawn) {
      return priceRoot.querySelector('[ref="priceContainer"]') || priceRoot.querySelector('div') || priceRoot;
    }
    return priceRoot; // for flat themes the root IS the container
  }

  // ── Show/hide a DOM element using the theme's mechanism ──────────────────────
  function show(el) {
    if (!el) return;
    if (T.hiddenClass) el.classList.remove(T.hiddenClass);
    else               el.style.display = '';
  }
  function hide(el) {
    if (!el) return;
    if (T.hiddenClass) el.classList.add(T.hiddenClass);
    else               el.style.display = 'none';
  }
  function isHidden(el) {
    if (!el) return true;
    if (T.hiddenClass) return el.classList.contains(T.hiddenClass);
    return el.style.display === 'none';
  }

  // ── Reset a price container to its original state ────────────────────────────
  function resetPriceContainer(container) {
    if (!container.dataset.b2bApplied) return;

    // Restore original regular price text if we saved it
    if (container.dataset.b2bOriginal) {
      var regSection2 = T.regularSel ? container.querySelector(T.regularSel) : null;
      var regEl = regSection2
        ? regSection2.querySelector(T.regularAmtSel)
        : container.querySelector(T.regularAmtSel);
      if (regEl) regEl.textContent = container.dataset.b2bOriginal;
      delete container.dataset.b2bOriginal;
    }

    // Restore section visibility
    var regSection  = T.regularSel ? container.querySelector(T.regularSel) : null;
    var saleSection = T.saleSel    ? container.querySelector(T.saleSel)    : null;
    if (regSection)  show(regSection);
    if (saleSection) hide(saleSection);

    // Remove injected elements and restore visibility hidden by _injectFallbackPrice
    var fb  = container.querySelector('.b2b-price-fallback');
    var inj = container.querySelector('.b2b-orig-inject');
    if (fb)  fb.remove();
    if (inj) inj.remove();
    Array.from(container.children).forEach(function (c) {
      if (c.style.visibility === 'hidden') c.style.visibility = '';
    });

    delete container.dataset.b2bApplied;
  }

  // ── Apply wholesale price to a container ─────────────────────────────────────
  function applyWholesaleToContainer(container, entry) {
    var display = entry.priceDisplay || priceDisplay;

    if (display === 'REPLACED') {
      _applyReplaced(container, entry);
    } else {
      // ORIGINAL_AND_DISCOUNTED
      _applyOriginalAndDiscounted(container, entry);
    }
    container.dataset.b2bApplied = '1';
  }

  // Replace: show only wholesale price
  function _applyReplaced(container, entry) {
    var regSection  = T.regularSel ? container.querySelector(T.regularSel) : null;
    var saleSection = T.saleSel    ? container.querySelector(T.saleSel)    : null;

    if (regSection) {
      // Theme has separate regular/sale sections (Dawn-style)
      var regEl = regSection.querySelector(T.regularAmtSel);
      if (regEl) {
        if (!container.dataset.b2bOriginal) container.dataset.b2bOriginal = regEl.textContent.trim();
        regEl.textContent = fmt(entry.wholesalePriceCents);
      }
      show(regSection);
      if (saleSection) hide(saleSection);
    } else {
      // Flat theme — just replace the main price text
      var amtEl = container.querySelector(T.regularAmtSel) ||
                  container.querySelector(T.saleAmtSel)    ||
                  container.querySelector('.money');
      if (amtEl) {
        if (!container.dataset.b2bOriginal) container.dataset.b2bOriginal = amtEl.textContent.trim();
        amtEl.textContent = fmt(entry.wholesalePriceCents);
      } else {
        _injectFallbackPrice(container, fmt(entry.wholesalePriceCents), null);
      }
    }
  }

  // Show original (strikethrough) + discounted price side by side
  function _applyOriginalAndDiscounted(container, entry) {
    var regSection  = T.regularSel ? container.querySelector(T.regularSel) : null;
    var saleSection = T.saleSel    ? container.querySelector(T.saleSel)    : null;

    if (saleSection) {
      // Dawn-style: show sale section, put wholesale in .price-item--sale, original in compare-at
      var saleEl    = saleSection.querySelector(T.saleAmtSel);
      var compareEl = T.compareAmtSel ? saleSection.querySelector(T.compareAmtSel) : null;
      var regElO    = regSection ? regSection.querySelector(T.regularAmtSel) : null;
      // Capture original text before we hide the regular section
      var origText  = (regElO ? regElO.textContent.trim() : '') || fmt(entry.originalPriceCents);

      if (saleEl) {
        saleEl.textContent = fmt(entry.wholesalePriceCents);
        if (compareEl) {
          compareEl.textContent = origText;
          show(compareEl);
        } else if (origText) {
          // Product has no Shopify compare-at price → the <s> element doesn't exist in DOM.
          // Inject one so the original price is visible alongside the wholesale price.
          var inj = saleSection.querySelector('.b2b-orig-inject');
          if (!inj) {
            inj = document.createElement('s');
            inj.className = 'b2b-orig-inject';
            inj.style.cssText = 'color:#9ca3af;font-size:0.9em;margin-right:6px;';
            saleSection.insertBefore(inj, saleEl);
          }
          inj.textContent = origText;
        }
        show(saleSection);
        if (regSection) hide(regSection);
        return;
      }
    }

    // Flat theme or missing sale section — inject our own markup
    var existingAmt = container.querySelector(T.regularAmtSel) ||
                      container.querySelector(T.saleAmtSel)    ||
                      container.querySelector('.money');
    var originalText = (existingAmt ? existingAmt.textContent.trim() : null) ||
                       fmt(entry.originalPriceCents);
    if (existingAmt) {
      if (!container.dataset.b2bOriginal) container.dataset.b2bOriginal = existingAmt.textContent.trim();
    }

    // Check if compare-at element already exists in the theme
    var compareEl = T.compareAmtSel ? container.querySelector(T.compareAmtSel) : null;
    if (compareEl && existingAmt) {
      compareEl.textContent = originalText;
      show(compareEl);
      existingAmt.textContent = fmt(entry.wholesalePriceCents);
      return;
    }

    // Inject fallback: strikethrough original + highlighted new price
    _injectFallbackPrice(container, fmt(entry.wholesalePriceCents), originalText);
  }

  // Inject a B2B price block when the theme structure isn't available
  function _injectFallbackPrice(container, priceText, compareText) {
    var fb = container.querySelector('.b2b-price-fallback');
    if (!fb) {
      fb = document.createElement('div');
      fb.className = 'b2b-price-fallback';
      fb.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
      // Hide existing children
      Array.from(container.children).forEach(function (c) {
        if (!c.classList.contains('b2b-price-fallback')) c.style.visibility = 'hidden';
      });
      container.appendChild(fb);
    }
    var compareHtml = compareText
      ? '<s style="color:#9ca3af;font-size:0.9em;">' + compareText + '</s>'
      : '';
    fb.innerHTML = compareHtml + '<span style="font-weight:600;">' + priceText + '</span>';
  }

  // ── Parse a price string → cents (handles European and Anglo formats) ────────
  function parsePriceCents(text) {
    var stripped = text.replace(/[^\d.,]/g, '');
    if (!stripped) return 0;
    var num;
    var lastDot   = stripped.lastIndexOf('.');
    var lastComma = stripped.lastIndexOf(',');
    if (lastComma > lastDot) {
      // European: "5.075,00" or "25,70" — comma is decimal separator
      num = parseFloat(stripped.replace(/\./g, '').replace(',', '.'));
    } else {
      // Anglo: "5,075.00" or "25.70" — dot is decimal separator
      num = parseFloat(stripped.replace(/,/g, ''));
    }
    if (isNaN(num) || num <= 0) return 0;
    return Math.round(num * 100);
  }

  // ── Read the original (pre-B2B) Shopify price from a container ───────────────
  // Saves the text in b2bBasePrice on first read — a permanent anchor that is
  // NEVER deleted, so repeated calls always return the original Shopify price
  // even if the DOM has been modified by a previous apply cycle.
  // Call clearBasePrices() on variant changes to pick up the new variant price.
  function readCurrentPriceCents(container) {
    if (container.dataset.b2bBasePrice) {
      return parsePriceCents(container.dataset.b2bBasePrice);
    }
    var el = null;
    if (T.regularSel) {
      var regSec = container.querySelector(T.regularSel);
      if (regSec) el = regSec.querySelector(T.regularAmtSel);
    }
    if (!el) el = container.querySelector(T.regularAmtSel);
    if (!el) el = container.querySelector('.money');
    if (!el) return 0;
    var text = el.textContent.trim();
    container.dataset.b2bBasePrice = text;
    return parsePriceCents(text);
  }

  // ── Clear cached base prices (call on variant change so new variant's price
  //    is picked up from the DOM on the next readCurrentPriceCents call) ─────────
  function clearBasePrices() {
    document.querySelectorAll(T.priceRootSel).forEach(function (priceRoot) {
      var c = getContainer(priceRoot);
      if (c) delete c.dataset.b2bBasePrice;
    });
  }

  // ── Apply wholesale prices to all price elements on the page ─────────────────
  function applyAllWholesalePrices() {
    var roots   = document.querySelectorAll(T.priceRootSel);
    var applied = 0;
    roots.forEach(function (priceRoot) {
      var variantId = getVariantIdFor(priceRoot);
      var entry     = variantId ? priceMap[variantId] : null;
      var container = getContainer(priceRoot);
      if (!container) return;

      resetPriceContainer(container);

      // Per-item server price (best-price-wins already computed by proxy across
      // ALL catalogs — no need to re-compare with catalog-level rules here).
      var bestEntry = entry && entry.wholesalePriceCents > 0 ? entry : null;

      // Catalog-level fixedOff / fixedPrice rules apply ONLY when there is no
      // per-item server price. The proxy places items with known base prices in
      // products[] already, so DOM reading is only needed for items whose base
      // price wasn't stored in the catalog (customPriceCents = 0).
      if (!bestEntry) {
        var varRule = variantId ? fixedOffVariants[variantId] : null;
        if (varRule && varRule.fixedOff > 0) {
          var domC = readCurrentPriceCents(container);
          if (domC > 0) {
            var varFixed = Math.max(1, domC - varRule.fixedOff);
            if (varFixed < domC) {
              bestEntry = { wholesalePriceCents: varFixed, originalPriceCents: domC, priceDisplay: varRule.priceDisplay };
            }
          }
        } else if (globalFixedOff > 0) {
          var domC2 = readCurrentPriceCents(container);
          if (domC2 > 0) {
            var gFixed = Math.max(1, domC2 - globalFixedOff);
            if (gFixed < domC2) {
              bestEntry = { wholesalePriceCents: gFixed, originalPriceCents: domC2, priceDisplay: globalFixedOffDisplay };
            }
          }
        } else if (globalFixedPrice > 0) {
          var origC = readCurrentPriceCents(container);
          bestEntry = { wholesalePriceCents: globalFixedPrice, originalPriceCents: origC, priceDisplay: globalFixedPriceDisplay };
        }
      }

      if (bestEntry && bestEntry.wholesalePriceCents > 0) {
        applyWholesaleToContainer(container, bestEntry);
        applied++;
      }
    });
    if (roots.length > 0) {
      console.log('[B2B] applied ' + applied + '/' + roots.length + ' prices | theme=' + themeName);
    }
  }

  // ── Write cart attribute so discount function can identify the customer ───────
  function setCartAttributes() {
    if (!customerId) return;
    fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributes: { '_b2b_customer_id': customerId } }),
    }).catch(function (e) { console.warn('[B2B] cart attributes error:', e); });
  }

  // ── Watch for variant changes (product page selector) ────────────────────────
  function observeVariantInputs() {
    document.querySelectorAll('form[action*="/cart/add"]').forEach(function (form) {
      var inp = form.querySelector('input[name="id"]') || form.querySelector('select[name="id"]');
      if (!inp) return;
      new MutationObserver(function () {
        clearBasePrices();
        scheduleFetch(50);
        // No setTimeout(applyAllWholesalePrices) here — executeFetch calls it once
        // priceMap is confirmed, preventing an intermediate apply with empty/stale data.
      }).observe(inp, { attributes: true, attributeFilter: ['value'] });

      if (inp.tagName === 'SELECT') {
        inp.addEventListener('change', function () {
          clearBasePrices();
          scheduleFetch(50);
        });
      }
    });
  }

  // ── Event listeners ───────────────────────────────────────────────────────────
  // Shopify's variant:changed (most modern themes)
  document.addEventListener('variant:changed', function () {
    clearBasePrices();
    scheduleFetch(50);
  });

  // Generic form change inside add-to-cart forms (quantity, etc.)
  // Do NOT clearBasePrices here — only actual variant-ID changes warrant that.
  document.addEventListener('change', function (e) {
    if (e.target && e.target.closest('form[action*="/cart/add"]')) {
      scheduleFetch(50);
    }
  });

  // URL change (collection filters, pagination)
  var lastSearch = window.location.search;
  setInterval(function () {
    if (window.location.search !== lastSearch) {
      lastSearch = window.location.search;
      scheduleFetch(100);
    }
  }, 250);

  // Cart updated events — re-enforce minimum order
  document.addEventListener('cart:updated',  function () { setTimeout(enforceMinimumOrder, 150); });
  document.addEventListener('cart-update',   function () { setTimeout(enforceMinimumOrder, 150); });
  document.addEventListener('change', function (e) {
    if (e.target && (
      e.target.name === 'quantity' ||
      e.target.closest('[data-cart-item]') ||
      e.target.closest('cart-items')
    )) {
      setTimeout(enforceMinimumOrder, 400);
    }
  });

  // Theme editor live reload
  if (window.Shopify && window.Shopify.theme) {
    document.addEventListener('shopify:section:load', function () {
      setTimeout(function () { applyAllWholesalePrices(); enforceMinimumOrder(); }, 200);
    });
  }

  // Periodic re-enforce minimum order
  if (customerId) {
    setInterval(function () { if (minimumOrderCents > 0) enforceMinimumOrder(); }, 5000);
  }

  // ── MutationObserver: new products added (infinite scroll, carousels, quick-view)
  new MutationObserver(function (mutations) {
    var needsFetch = false;
    mutations.forEach(function (m) {
      m.addedNodes.forEach(function (node) {
        if (node.nodeType !== 1) return;
        // Check if a price root or variant input was added
        if (
          node.matches(T.priceRootSel)         ||
          node.querySelector(T.priceRootSel)   ||
          node.matches('input[name="id"]')      ||
          node.querySelector('input[name="id"]')
        ) {
          needsFetch = true;
        }
        // Also handle form additions (quick-view modals, drawer carts, etc.)
        if (node.matches('form[action*="/cart/add"]') || node.querySelector('form[action*="/cart/add"]')) {
          needsFetch = true;
        }
      });
    });
    // scheduleFetch triggers executeFetch which calls applyAllWholesalePrices once
    // priceMap is confirmed — no separate setTimeout needed (avoids premature apply).
    if (needsFetch) scheduleFetch(150);
    if (customerId && minimumOrderCents > 0) setTimeout(enforceMinimumOrder, 30);
  }).observe(document.body, { childList: true, subtree: true });

  // ── Price cache refresh every 5 min ──────────────────────────────────────────
  setInterval(function () {
    fetchedIds.clear();
    minimumOrderFetched = false;
    clearBasePrices();
    scheduleFetch(0);
  }, 5 * 60 * 1000);

  // ── Init ──────────────────────────────────────────────────────────────────────
  function init() {
    setCartAttributes();
    observeVariantInputs();
    scheduleFetch(200); // slight delay lets theme finish async rendering
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
