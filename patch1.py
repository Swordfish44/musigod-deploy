import re

with open(r'C:\musigod-deploy\index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the comment and replace everything between it and the pricing-grid
fee_disclosure = '''      <!-- FEE TRANSPARENCY DISCLOSURE -->
      <div style="background:#1a1a1a;border:1px solid #DC2626;border-radius:8px;padding:1.5rem 2rem;margin:2rem auto;max-width:900px;">
        <div style="display:flex;align-items:flex-start;gap:1rem;">
          <span style="color:#DC2626;font-size:1.4rem;">&#9888;</span>
          <div>
            <p style="color:#fff;font-weight:700;margin:0 0 0.5rem 0;">About Registration Fees</p>
            <p style="color:#ccc;font-size:0.9rem;margin:0 0 1rem 0;">Your MusiGod subscription covers our service. Some registration bodies charge one-time fees paid <strong style="color:#fff;">directly by you to that organization</strong> — not to MusiGod. Most registrations are free. Fee-bearing registrations total approximately <strong style="color:#fff;">-650</strong> for a fully built-out US and international stack, paid once.</p>
            <details><summary style="color:#DC2626;font-size:0.85rem;font-weight:600;cursor:pointer;">See full fee schedule</summary>
              <table style="width:100%;margin-top:1rem;border-collapse:collapse;font-size:0.85rem;">
                <tr style="border-bottom:1px solid #333;"><th style="text-align:left;padding:0.5rem;color:#999;">Registration</th><th style="text-align:left;padding:0.5rem;color:#999;">Fee</th><th style="text-align:left;padding:0.5rem;color:#999;">Paid To</th></tr>
                <tr><td style="padding:0.5rem;color:#fff;">ASCAP Writer</td><td style="padding:0.5rem;color:#DC2626;"> one-time</td><td style="padding:0.5rem;color:#aaa;">ASCAP directly</td></tr>
                <tr><td style="padding:0.5rem;color:#fff;">ASCAP Publisher</td><td style="padding:0.5rem;color:#DC2626;"> one-time</td><td style="padding:0.5rem;color:#aaa;">ASCAP directly</td></tr>
                <tr><td style="padding:0.5rem;color:#fff;">BMI Publisher</td><td style="padding:0.5rem;color:#DC2626;"> one-time</td><td style="padding:0.5rem;color:#aaa;">BMI directly</td></tr>
                <tr><td style="padding:0.5rem;color:#fff;">PRS (UK)</td><td style="padding:0.5rem;color:#DC2626;">GBP 100 one-time</td><td style="padding:0.5rem;color:#aaa;">PRS directly</td></tr>
                <tr><td style="padding:0.5rem;color:#fff;">GEMA (Germany)</td><td style="padding:0.5rem;color:#DC2626;">~EUR 60/year</td><td style="padding:0.5rem;color:#aaa;">GEMA directly</td></tr>
                <tr><td style="padding:0.5rem;color:#fff;">Trademark (USPTO)</td><td style="padding:0.5rem;color:#DC2626;">-350 one-time</td><td style="padding:0.5rem;color:#aaa;">USPTO directly</td></tr>
                <tr><td style="padding:0.5rem;color:#fff;">State LLC</td><td style="padding:0.5rem;color:#DC2626;">-500 (varies)</td><td style="padding:0.5rem;color:#aaa;">Your state directly</td></tr>
                <tr><td style="padding:0.5rem;color:#fff;">All other registrations</td><td style="padding:0.5rem;color:#22c55e;">Free</td><td style="padding:0.5rem;color:#aaa;">N/A</td></tr>
              </table>
            </details>
          </div>
        </div>
      </div>'''

old_marker = '<!-- FEE TRANSPARENCY DISCLOSURE -->'

if old_marker in content:
    idx = content.index(old_marker)
    end_marker = '<div class="pricing-grid">'
    end_idx = content.index(end_marker, idx)
    content = content[:idx] + fee_disclosure + '\n\n      ' + content[end_idx:]
    with open(r'C:\musigod-deploy\index.html', 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print('ERROR: marker not found')
