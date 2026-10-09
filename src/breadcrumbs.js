// Builds the breadcrumb trail from the URL. ':id' segments use the label
// supplied by the route (res.locals.crumbLabel) or the page title.
const LABELS = {
  '/periods': 'Payroll Periods',
  '/periods/:id': null,
  '/periods/:id/adjustments': 'Adjustments',
  '/periods/:id/register': 'Payroll Register',
  '/periods/:id/payslips': 'Payslips',
  '/dtr': 'Daily Time Record',
  '/dtr/import': 'Import',
  '/loans': 'Loans',
  '/loans/:id': null,
  '/employees': 'Employees',
  '/employees/new': 'New employee',
  '/employees/import': 'Import from Excel',
  '/employees/:id': null,
  '/employees/:id/edit': null,
  '/holidays': 'Holidays',
  '/settings': 'Company Settings',
  '/settings/lists': 'Departments',
  '/settings/pay-items': 'Allowances and Deductions',
  '/settings/rates': 'Government Rates',
  '/users': 'Users',
  '/audit': 'Audit Log',
  '/account': 'Account',
  '/account/password': 'Change password',
};

// Parent pages that have no page of their own redirect to a sensible place
const LINK_OVERRIDE = { '/employees/:id': null, '/account': null };

function buildCrumbs(urlPath, title, idLabel) {
  if (urlPath === '/') return [];
  const segs = urlPath.split('/').filter(Boolean);
  const crumbs = [{ label: 'Dashboard', href: '/' }];
  let real = '';
  let pattern = '';
  segs.forEach((seg, i) => {
    real += '/' + seg;
    pattern += '/' + (/^\d+$/.test(seg) ? ':id' : seg);
    if (!(pattern in LABELS)) return;
    const last = i === segs.length - 1;
    let label = LABELS[pattern];
    if (label === null) label = idLabel || title;
    // '/employees/:id/edit' is the page itself; skip the bare '/employees/:id' crumb
    if (pattern === '/employees/:id' && segs[i + 1] === 'edit') return;
    if (pattern === '/employees/:id/edit') label = idLabel || title;
    const noLink = last || pattern in LINK_OVERRIDE;
    crumbs.push({ label, href: noLink ? null : real });
  });
  return crumbs;
}

module.exports = { buildCrumbs };
