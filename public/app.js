// Small progressive enhancements. Every page works without this file.
(function () {
  'use strict';

  // Bring the apply form's error summary into view and focus.
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

  // Ask before destructive actions.
  document.addEventListener('submit', function (e) {
    var btn = e.submitter;
    var msg = btn && btn.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // Show the Voltax fields only when "Onboarded" is picked.
  document.querySelectorAll('.voltax-fields[data-show-for]').forEach(function (box) {
    var form = box.closest('form');
    var select = form && form.querySelector('select[name="stage"]');
    if (!select) return;
    var update = function () {
      var want = box.getAttribute('data-show-for');
      box.hidden = select.value !== want || box.getAttribute('data-current') === want;
    };
    select.addEventListener('change', update);
    update();
  });
})();
