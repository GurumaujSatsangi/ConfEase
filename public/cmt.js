/* CMT interaction layer: replaces Bootstrap's JavaScript.
   Provides the same `bootstrap.Modal` / `bootstrap.Popover` API that the pages call, and handles
   data-bs-toggle (collapse, dropdown, modal, popover) and data-bs-dismiss="modal". */
(function () {
  "use strict";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function resolveEl(target) {
    if (!target) return null;
    return typeof target === "string" ? $(target) : target;
  }

  // ---------- Modal ----------
  var openModals = [];

  function Modal(target, options) {
    this._el = resolveEl(target);
    options = options || {};
    var data = (this._el && this._el.dataset) || {};
    this._static = options.backdrop === "static" || data.bsBackdrop === "static";
    this._keyboard = options.keyboard !== undefined ? options.keyboard : data.bsKeyboard !== "false";
    this._backdrop = null;
    if (this._el) this._el.__cmtModal = this;
  }

  Modal.getInstance = function (el) {
    el = resolveEl(el);
    return (el && el.__cmtModal) || null;
  };

  Modal.prototype.show = function () {
    var el = this._el;
    if (!el || el.classList.contains("show")) return;
    var bd = document.createElement("div");
    bd.className = "modal-backdrop-cmt";
    document.body.appendChild(bd);
    this._backdrop = bd;
    el.style.display = "block";
    el.removeAttribute("aria-hidden");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("role", "dialog");
    void el.offsetWidth; // force layout so the show transition runs
    el.classList.add("show");
    document.body.classList.add("cmt-modal-open");
    openModals.push(this);
    var evt = new CustomEvent("shown.bs.modal");
    el.dispatchEvent(evt);
  };

  Modal.prototype.hide = function () {
    var el = this._el;
    if (!el || !el.classList.contains("show")) return;
    el.classList.remove("show");
    el.style.display = "";
    el.setAttribute("aria-hidden", "true");
    el.removeAttribute("aria-modal");
    if (this._backdrop) { this._backdrop.remove(); this._backdrop = null; }
    openModals = openModals.filter(function (m) { return m !== this; }, this);
    if (openModals.length === 0) document.body.classList.remove("cmt-modal-open");
    el.dispatchEvent(new CustomEvent("hidden.bs.modal"));
  };

  Modal.prototype.toggle = function () {
    if (this._el && this._el.classList.contains("show")) this.hide(); else this.show();
  };

  Modal.prototype.dispose = function () { this.hide(); };

  // Backdrop click and Escape close the modal unless it is static / keyboard disabled
  document.addEventListener("click", function (e) {
    var modalEl = e.target.classList && e.target.classList.contains("modal") ? e.target : null;
    if (!modalEl) return;
    var inst = Modal.getInstance(modalEl);
    if (inst && !inst._static) inst.hide();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || openModals.length === 0) return;
    var top = openModals[openModals.length - 1];
    if (top._keyboard && !top._static) top.hide();
  });

  // ---------- Popover (click or hover on the trigger) ----------
  var activePopover = null;

  function Popover(target, options) {
    this._el = resolveEl(target);
    this._options = options || {};
    this._pop = null;
    if (!this._el) return;
    var self = this;
    this._el.addEventListener("click", function (ev) {
      ev.preventDefault();
      self.toggle();
    });
  }

  Popover.getInstance = function (el) { return resolveEl(el) && resolveEl(el).__cmtPopover; };

  Popover.prototype._content = function () {
    var d = this._el.dataset || {};
    return {
      title: this._options.title || d.bsTitle || this._el.getAttribute("title") || "",
      body: this._options.content || d.bsContent || ""
    };
  };

  Popover.prototype.show = function () {
    if (activePopover && activePopover !== this) activePopover.hide();
    if (this._pop) return;
    var c = this._content();
    var pop = document.createElement("div");
    pop.className = "popover";
    pop.setAttribute("role", "tooltip");
    if (c.title) {
      var h = document.createElement("div");
      h.className = "popover-header";
      h.textContent = c.title;
      pop.appendChild(h);
    }
    var b = document.createElement("div");
    b.className = "popover-body";
    b.textContent = c.body;
    pop.appendChild(b);
    document.body.appendChild(pop);
    var r = this._el.getBoundingClientRect();
    pop.style.top = (window.scrollY + r.bottom + 6) + "px";
    pop.style.left = (window.scrollX + r.left) + "px";
    this._pop = pop;
    activePopover = this;
  };

  Popover.prototype.hide = function () {
    if (this._pop) { this._pop.remove(); this._pop = null; }
    if (activePopover === this) activePopover = null;
  };

  Popover.prototype.toggle = function () { if (this._pop) this.hide(); else this.show(); };

  Popover.prototype.dispose = function () { this.hide(); };

  document.addEventListener("click", function (e) {
    if (activePopover && !activePopover._el.contains(e.target)) activePopover.hide();
  });

  // Auto-initialise popovers declared with data-bs-toggle="popover"
  function initPopovers(root) {
    (root || document).querySelectorAll('[data-bs-toggle="popover"]').forEach(function (el) {
      if (!el.__cmtPopover) el.__cmtPopover = new Popover(el);
    });
  }

  // ---------- data-bs-toggle handlers ----------
  document.addEventListener("click", function (e) {
    var trigger = e.target.closest("[data-bs-toggle], [data-bs-dismiss]");
    if (!trigger) return;

    var dismiss = trigger.getAttribute("data-bs-dismiss");
    if (dismiss === "modal") {
      var m = trigger.closest(".modal");
      var inst = m && Modal.getInstance(m);
      if (inst) inst.hide(); else if (m) m.classList.remove("show");
      return;
    }

    var kind = trigger.getAttribute("data-bs-toggle");
    var targetSel = trigger.getAttribute("data-bs-target") || trigger.getAttribute("href");

    if (kind === "modal") {
      e.preventDefault();
      var target = resolveEl(targetSel);
      if (!target) return;
      var mi = Modal.getInstance(target) || new Modal(target);
      mi.show();
      return;
    }

    if (kind === "collapse") {
      e.preventDefault();
      var panel = resolveEl(targetSel);
      if (!panel) return;
      var opening = !panel.classList.contains("show");
      var parentSel = trigger.getAttribute("data-bs-parent");
      if (parentSel && opening) {
        var parent = resolveEl(parentSel);
        if (parent) {
          parent.querySelectorAll(".collapse.show").forEach(function (other) {
            if (other !== panel) {
              other.classList.remove("show");
              var t = parent.querySelector('[data-bs-target="#' + other.id + '"]');
              if (t) { t.classList.add("collapsed"); t.setAttribute("aria-expanded", "false"); }
            }
          });
        }
      }
      panel.classList.toggle("show", opening);
      trigger.classList.toggle("collapsed", !opening);
      trigger.setAttribute("aria-expanded", opening ? "true" : "false");
      return;
    }

    if (kind === "dropdown") {
      e.preventDefault();
      var menu = trigger.parentElement && trigger.parentElement.querySelector(".dropdown-menu");
      if (!menu) return;
      var willOpen = !menu.classList.contains("show");
      document.querySelectorAll(".dropdown-menu.show").forEach(function (d) { d.classList.remove("show"); });
      menu.classList.toggle("show", willOpen);
      return;
    }
  });

  document.addEventListener("click", function (e) {
    if (!e.target.closest(".dropdown")) {
      document.querySelectorAll(".dropdown-menu.show").forEach(function (d) { d.classList.remove("show"); });
    }
  });

  document.addEventListener("DOMContentLoaded", function () { initPopovers(); });

  // Public API, matching the names the page scripts already use
  window.bootstrap = { Modal: Modal, Popover: Popover };
})();
