// Small progressive enhancements. Every page works without this file.
(function () {
  'use strict';

  // Bring the error summary (apply form and admin forms) into view and focus.
  var summary = document.getElementById('error-summary');
  if (summary) summary.focus();

  // Email hand-off page: follow the Gmail / mailto link on its own. Without JS the user clicks the link.
  var handoff = document.querySelector('a[data-auto-open]');
  if (handoff) {
    var target = handoff.getAttribute('href') || '';
    if (target.indexOf('https://mail.google.com/mail/?') === 0 || target.indexOf('mailto:') === 0) {
      window.location.replace(target);
    }
  }

  // The Manage dropdown is a <details> (works without JavaScript): also close it on Escape or a click elsewhere.
  var manage = document.querySelector('details.nav-manage');
  if (manage) {
    document.addEventListener('click', function (e) {
      if (manage.open && !manage.contains(e.target)) manage.open = false;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && manage.open) {
        manage.open = false;
        var summary = manage.querySelector('summary');
        if (summary) summary.focus();
      }
    });
  }

  // Show the Voltax fields only when the picked stage is the role's Onboarded stage (its option has data-kind).
  document.querySelectorAll('.voltax-fields[data-show-for]').forEach(function (box) {
    var form = box.closest('form');
    var select = form && form.querySelector('select[name="stage"]');
    if (!select) return;
    var update = function () {
      var want = box.getAttribute('data-show-for');
      var option = select.options[select.selectedIndex];
      box.hidden = !option || option.getAttribute('data-kind') !== want;
    };
    select.addEventListener('change', update);
    update();
  });
})();
