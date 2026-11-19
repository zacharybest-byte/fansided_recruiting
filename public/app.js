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

  // Show the Voltax fields only when "Onboarded" is picked.
  document.querySelectorAll('.voltax-fields[data-show-for]').forEach(function (box) {
    var form = box.closest('form');
    var select = form && form.querySelector('select[name="stage"]');
    if (!select) return;
    var update = function () {
      var want = box.getAttribute('data-show-for');
      box.hidden = select.value !== want;
    };
    select.addEventListener('change', update);
    update();
  });
})();
