import PDFDocument from 'pdfkit';

/**
 * Helper to build PDF buffer from a PDFKit document
 */
function buildPdf(options, builder) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument(options);
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      builder(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Generate official BUP Conference Certificate in PDF
 */
export async function generateCertificatePdf({ certificate, conference, user, template }) {
  return buildPdf({ size: 'A4', layout: 'landscape', margin: 40 }, (doc) => {
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;

    // Outer decorative border (Forest Green)
    doc.save();
    doc.lineWidth(4);
    doc.strokeColor('#15803d');
    doc.rect(25, 25, pageWidth - 50, pageHeight - 50).stroke();

    // Inner decorative border (Gold accent)
    doc.lineWidth(1.5);
    doc.strokeColor('#d97706');
    doc.rect(32, 32, pageWidth - 64, pageHeight - 64).stroke();

    // Corner decorative accents
    const corners = [
      [36, 36],
      [pageWidth - 46, 36],
      [36, pageHeight - 46],
      [pageWidth - 46, pageHeight - 46],
    ];
    doc.fillColor('#15803d');
    for (const [cx, cy] of corners) {
      doc.rect(cx, cy, 10, 10).fill();
    }
    doc.restore();

    // Institution Heading
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#15803d')
      .text('BANGLADESH UNIVERSITY OF PROFESSIONALS', 0, 55, { align: 'center', width: pageWidth });
    
    doc.font('Helvetica').fontSize(9).fillColor('#64748b')
      .text('Mirpur Cantonment, Dhaka-1216, Bangladesh  •  www.bup.edu.bd', 0, 75, { align: 'center', width: pageWidth });

    // Certificate Title
    const title = template?.title || getCertificateDefaultTitle(certificate.certificate_type);
    doc.moveDown(1.2);
    doc.font('Helvetica-Bold').fontSize(24).fillColor('#0f172a')
      .text(title.toUpperCase(), 0, 105, { align: 'center', width: pageWidth });

    const subtitle = template?.subtitle || 'OFFICIAL CERTIFICATE OF RECOGNITION';
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#d97706')
      .text(subtitle.toUpperCase(), 0, 135, { align: 'center', width: pageWidth });

    // Presentation text
    doc.font('Helvetica-Oblique').fontSize(13).fillColor('#475569')
      .text('This is proudly presented to', 0, 165, { align: 'center', width: pageWidth });

    // Recipient Name
    doc.font('Helvetica-Bold').fontSize(26).fillColor('#15803d')
      .text(user.full_name || 'Honored Recipient', 0, 190, { align: 'center', width: pageWidth });

    if (user.institution) {
      doc.font('Helvetica').fontSize(11).fillColor('#64748b')
        .text(user.institution, 0, 225, { align: 'center', width: pageWidth });
    }

    // Body Text
    const bodyText = formatCertificateBodyText({ certificate, conference, user, template });
    doc.font('Helvetica').fontSize(12).fillColor('#334155').lineGap(5)
      .text(bodyText, 90, 255, { align: 'center', width: pageWidth - 180 });

    // If revoked, draw a clear watermark
    if (certificate.is_revoked) {
      doc.save();
      doc.font('Helvetica-Bold').fontSize(40).fillColor('#ef4444', 0.25)
        .text('REVOKED', 0, 260, { align: 'center', width: pageWidth });
      doc.restore();
    }

    // Signatures
    const sigY = pageHeight - 145;
    const sigName = template?.signatory_name || 'Conference General Chair';
    const sigTitle = template?.signatory_title || conference.title || 'Bangladesh University of Professionals';

    // Left Signature
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1e293b')
      .text(sigName, 80, sigY, { width: 220, align: 'center' });
    doc.lineWidth(0.8).strokeColor('#cbd5e1').moveTo(80, sigY - 5).lineTo(300, sigY - 5).stroke();
    doc.font('Helvetica').fontSize(9).fillColor('#64748b')
      .text(sigTitle, 80, sigY + 16, { width: 220, align: 'center' });

    // Right Signature
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1e293b')
      .text('Patron / Academic Chair', pageWidth - 300, sigY, { width: 220, align: 'center' });
    doc.lineWidth(0.8).strokeColor('#cbd5e1').moveTo(pageWidth - 300, sigY - 5).lineTo(pageWidth - 80, sigY - 5).stroke();
    doc.font('Helvetica').fontSize(9).fillColor('#64748b')
      .text('Bangladesh University of Professionals', pageWidth - 300, sigY + 16, { width: 220, align: 'center' });

    // Footer with Certificate ID and Verification URL
    const footerY = pageHeight - 65;
    const formattedIssueDate = new Date(certificate.issued_at || Date.now()).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0f172a')
      .text(`Certificate ID: ${certificate.certificate_number}`, 45, footerY);
    doc.font('Helvetica').fontSize(8.5).fillColor('#64748b')
      .text(`Issued on: ${formattedIssueDate}`, 45, footerY + 12);

    const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    doc.font('Helvetica').fontSize(8.5).fillColor('#15803d')
      .text(`Verify authenticity: ${clientOrigin}/certificate-verification?number=${encodeURIComponent(certificate.certificate_number)}`, pageWidth - 420, footerY, { width: 375, align: 'right' });
  });
}

function getCertificateDefaultTitle(type) {
  switch (type) {
    case 'presenter':
      return 'Certificate of Presentation';
    case 'author':
      return 'Certificate of Authorship';
    case 'reviewer':
      return 'Certificate of Reviewer Excellence';
    case 'organizer':
      return 'Certificate of Appreciation';
    case 'attendee':
    default:
      return 'Certificate of Participation';
  }
}

function formatCertificateBodyText({ certificate, conference, template }) {
  if (template?.body_text) {
    return template.body_text
      .replaceAll('{{conference_title}}', conference.title)
      .replaceAll('{{conference_acronym}}', conference.acronym || 'BUP')
      .replaceAll('{{venue}}', conference.venue || 'BUP Campus')
      .replaceAll('{{certificate_number}}', certificate.certificate_number);
  }

  const confTitle = conference.title;
  const venue = conference.venue ? ` held at ${conference.venue}` : '';
  const dates = conference.start_date
    ? ` during ${new Date(conference.start_date).toLocaleDateString()}`
    : '';

  switch (certificate.certificate_type) {
    case 'presenter':
      return `for presenting valuable scholarly research and participating in the technical paper presentations at the "${confTitle}"${venue}${dates}.`;
    case 'author':
      return `in recognition of authorship and scholarly contribution to the peer-reviewed conference proceedings of "${confTitle}"${venue}${dates}.`;
    case 'reviewer':
      return `in grateful recognition of dedicated service as a Technical Program Peer Reviewer ensuring academic rigor for "${confTitle}"${dates}.`;
    case 'organizer':
      return `with deep appreciation for valuable contribution, leadership, and service in organizing the "${confTitle}"${dates}.`;
    case 'attendee':
    default:
      return `in recognition of active attendance and participation in the scholarly sessions and academic proceedings of "${confTitle}"${venue}${dates}.`;
  }
}

/**
 * Generate Executive Conference Analytics Summary Report in PDF
 */
export async function generateExecutiveReportPdf({ conference, analytics, generatedBy }) {
  return buildPdf({ size: 'A4', margin: 40 }, (doc) => {
    const pageWidth = doc.page.width;

    // Header
    doc.rect(40, 40, pageWidth - 80, 5).fill('#15803d');
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#15803d')
      .text('BANGLADESH UNIVERSITY OF PROFESSIONALS', { align: 'left' });
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#0f172a')
      .text('Official Conference Executive & Analytics Report');
    doc.font('Helvetica').fontSize(9).fillColor('#64748b')
      .text(`Generated: ${new Date().toLocaleString()} by ${generatedBy.full_name || generatedBy.email} (Confidential)`);

    doc.moveDown(1);
    doc.lineWidth(1).strokeColor('#e2e8f0').moveTo(40, doc.y).lineTo(pageWidth - 40, doc.y).stroke();
    doc.moveDown(1);

    // Conference Details Box
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('1. Conference Overview');
    doc.font('Helvetica').fontSize(10).fillColor('#334155');
    doc.text(`Title: ${conference.title}`);
    doc.text(`Status: ${conference.status.toUpperCase()} | Timezone: ${conference.timezone || 'Asia/Dhaka'}`);
    doc.text(`Dates: ${conference.start_date || 'TBD'} to ${conference.end_date || 'TBD'}`);
    doc.text(`Venue: ${conference.venue || 'Main Campus, Mirpur'}`);

    doc.moveDown(1);

    // Section 2: Submissions & Peer Review
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('2. Research Papers & Peer Review Metrics');
    doc.font('Helvetica').fontSize(10).fillColor('#334155');
    const p = analytics.papers || {};
    doc.text(`• Total Submissions: ${p.total || 0}`);
    doc.text(`• Accepted: ${p.accepted || 0} | Rejected: ${p.rejected || 0} | Under Review: ${p.under_review || 0} | Revisions: ${p.revision_requested || 0}`);
    const acceptRate = p.total > 0 ? ((p.accepted / p.total) * 100).toFixed(1) : '0';
    doc.text(`• Acceptance Rate: ${acceptRate}%`);
    const r = analytics.reviews || {};
    doc.text(`• Total Reviews Assigned: ${r.totalAssigned || 0} | Completed: ${r.completed || 0} | Average Score: ${r.averageScore || 'N/A'}`);

    doc.moveDown(1);

    // Section 3: Registrations & Financial Reconciliation
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('3. Registrations & Financial Summary');
    doc.font('Helvetica').fontSize(10).fillColor('#334155');
    const reg = analytics.registrations || {};
    const fin = analytics.financials || {};
    doc.text(`• Total Registrations: ${reg.total || 0} (Confirmed: ${reg.confirmed || 0}, Pending: ${reg.pending || 0}, Cancelled: ${reg.cancelled || 0})`);
    doc.text(`• Attendee Categories: Author (${reg.byCategory?.author || 0}), Student (${reg.byCategory?.student || 0}), Professional (${reg.byCategory?.professional || 0}), General (${reg.byCategory?.general_attendee || 0})`);
    doc.text(`• Total Verified Revenue: BDT ${Number(fin.verifiedAmount || 0).toLocaleString()}`);
    doc.text(`• Payment Receipts: Verified (${fin.verifiedCount || 0}), Pending Review (${fin.pendingCount || 0}), Rejected (${fin.rejectedCount || 0})`);
    if (fin.refundedAmount > 0) {
      doc.text(`• Total Approved Refunds: BDT ${Number(fin.refundedAmount).toLocaleString()}`);
    }

    doc.moveDown(1);

    // Section 4: Scheduling & Attendance
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('4. Scheduling, Presentations & Attendance');
    doc.font('Helvetica').fontSize(10).fillColor('#334155');
    const att = analytics.attendance || {};
    doc.text(`• Total Sessions: ${att.totalSessions || 0} | Total Presentation Slots: ${att.totalSlots || 0}`);
    doc.text(`• Presentations Delivered: ${att.completedPresentations || 0} | Absent / Cancelled: ${att.absentOrCancelledPresentations || 0}`);
    doc.text(`• Verified Check-Ins: ${att.totalCheckIns || 0} (QR Code: ${att.qrCheckIns || 0}, Manual/Roster: ${att.manualCheckIns || 0})`);

    doc.moveDown(1);

    // Section 5: Certificates
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('5. Certificate Issuance');
    doc.font('Helvetica').fontSize(10).fillColor('#334155');
    const cert = analytics.certificates || {};
    doc.text(`• Total Certificates Issued: ${cert.totalIssued || 0}`);
    doc.text(`• Breakdown: Attendees (${cert.byType?.attendee || 0}), Presenters (${cert.byType?.presenter || 0}), Reviewers (${cert.byType?.reviewer || 0}), Organizers (${cert.byType?.organizer || 0})`);
    doc.text(`• Revoked Certificates: ${cert.revoked || 0}`);

    // Footer
    doc.fontSize(8).fillColor('#94a3b8')
      .text('BUP Conference Management System — Institutional Compliance & Audit Document', 40, doc.page.height - 35, { align: 'center', width: pageWidth - 80 });
  });
}

/**
 * Clean CSV builder with field quoting
 */
export function buildCsv(headers, rows) {
  const escapeCell = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replaceAll('"', '""')}"`;
    }
    return str;
  };

  const headerRow = headers.map((h) => escapeCell(h.label)).join(',');
  const dataRows = rows.map((row) =>
    headers.map((h) => escapeCell(typeof h.key === 'function' ? h.key(row) : row[h.key])).join(',')
  );

  return [headerRow, ...dataRows].join('\r\n');
}
