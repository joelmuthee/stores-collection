import { useState, useRef, useEffect } from 'react';
import { runOcr, saveScan } from './api.js';

export default function App() {
  const [screen, setScreen] = useState('home');
  const [scanType, setScanType] = useState('printed');
  const [employee, setEmployee] = useState(() => localStorage.getItem('employee') || '');
  const [showNameModal, setShowNameModal] = useState(false);
  const [capturedImage, setCapturedImage] = useState(null); // { dataUrl, base64, mediaType }
  const [scan, setScan] = useState(null);
  const [editedScan, setEditedScan] = useState(null);
  const [processingText, setProcessingText] = useState('');
  const [toast, setToast] = useState(null);
  const [dupeBanner, setDupeBanner] = useState(null);
  const [successData, setSuccessData] = useState(null);
  const [notes, setNotes] = useState('');
  const toastTimer = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileRef = useRef(null);

  const showToast = (msg) => {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  };

  useEffect(() => {
    if (screen !== 'camera') { stopCamera(); return; }
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      } catch {
        if (!cancelled) showToast('Camera unavailable — use Gallery instead.');
      }
    })();
    return () => { cancelled = true; stopCamera(); };
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  const processImage = async (base64, mediaType, type) => {
    setDupeBanner(null);
    setNotes('');
    setScreen('processing');
    setProcessingText('Reading receipt…');
    try {
      const res = await runOcr(base64, mediaType, type);
      if (!res.ok) {
        showToast(res.error || 'OCR failed. Try again.');
        setScreen('camera');
        return;
      }
      setScan(res.scan);
      setEditedScan(JSON.parse(JSON.stringify(res.scan)));
      setScreen('review');
    } catch {
      showToast('Network error. Check your connection.');
      setScreen('camera');
    }
  };

  const handleCapture = async () => {
    const video = videoRef.current;
    if (!video?.videoWidth) return;

    // Try ImageCapture API — uses full camera sensor resolution, not just video stream
    const track = streamRef.current?.getVideoTracks()[0];
    if (track && typeof ImageCapture !== 'undefined') {
      try {
        const ic = new ImageCapture(track);
        const blob = await ic.takePhoto();
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target.result;
          const base64 = dataUrl.split(',')[1];
          setCapturedImage({ dataUrl, base64, mediaType: blob.type || 'image/jpeg' });
          processImage(base64, blob.type || 'image/jpeg', scanType);
        };
        reader.readAsDataURL(blob);
        return;
      } catch (err) {
        console.warn('ImageCapture failed, falling back to canvas:', err);
      }
    }

    // Fallback: canvas capture from video frame
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
    const base64 = dataUrl.split(',')[1];
    setCapturedImage({ dataUrl, base64, mediaType: 'image/jpeg' });
    processImage(base64, 'image/jpeg', scanType);
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const base64 = dataUrl.split(',')[1];
      const mediaType = file.type || 'image/jpeg';
      setCapturedImage({ dataUrl, base64, mediaType });
      processImage(base64, mediaType, scanType);
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (force = false) => {
    setProcessingText('Saving…');
    setScreen('processing');
    try {
      const payload = {
        scan: editedScan,
        stores_employee: employee || undefined,
        notes: notes || undefined,
        ...(force && { force: true }),
      };
      const res = await saveScan(payload);
      if (!res.ok && res.duplicate && !force) {
        setScreen('review');
        setDupeBanner(res.error || 'Duplicate transaction reference detected.');
        return;
      }
      if (!res.ok) {
        setScreen('review');
        showToast(res.error || 'Save failed. Try again.');
        return;
      }
      setSuccessData({ trnx_ref: editedScan?.trnx_ref, flags: res.flags });
      setScreen('success');
    } catch {
      setScreen('review');
      showToast('Network error. Check your connection.');
    }
  };

  const handleScanAnother = () => {
    setScan(null);
    setEditedScan(null);
    setCapturedImage(null);
    setDupeBanner(null);
    setSuccessData(null);
    setNotes('');
    setScreen('home');
  };

  return (
    <>
      {screen === 'home' && (
        <HomeScreen
          scanType={scanType}
          setScanType={setScanType}
          employee={employee}
          onEditEmployee={() => setShowNameModal(true)}
          onScan={() => setScreen('camera')}
        />
      )}
      {screen === 'camera' && (
        <CameraScreen
          videoRef={videoRef}
          fileRef={fileRef}
          onCapture={handleCapture}
          onGallery={() => fileRef.current?.click()}
          onFileChange={handleFileChange}
          onBack={() => setScreen('home')}
        />
      )}
      {screen === 'processing' && (
        <ProcessingScreen image={capturedImage?.dataUrl} text={processingText} />
      )}
      {screen === 'review' && editedScan && (
        <ReviewScreen
          scan={scan}
          editedScan={editedScan}
          image={capturedImage?.dataUrl}
          employee={employee}
          dupeBanner={dupeBanner}
          notes={notes}
          onNotesChange={setNotes}
          onFieldChange={(field, value) => setEditedScan(prev => ({ ...prev, [field]: value }))}
          onItemChange={(idx, field, value) => setEditedScan(prev => {
            const items = [...(prev.items || [])];
            items[idx] = { ...items[idx], [field]: value };
            return { ...prev, items };
          })}
          onSubmit={() => handleSubmit(false)}
          onForceSubmit={() => handleSubmit(true)}
          onBack={() => setScreen('camera')}
        />
      )}
      {screen === 'success' && (
        <SuccessScreen data={successData} onScanAnother={handleScanAnother} />
      )}
      {showNameModal && (
        <NameModal
          current={employee}
          onSave={(name) => {
            const trimmed = name.trim();
            setEmployee(trimmed);
            trimmed ? localStorage.setItem('employee', trimmed) : localStorage.removeItem('employee');
            setShowNameModal(false);
          }}
          onCancel={() => setShowNameModal(false)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

// ─────────────────────────────────────────────
// HomeScreen
// ─────────────────────────────────────────────
function HomeScreen({ scanType, setScanType, employee, onEditEmployee, onScan }) {
  return (
    <div className="screen home">
      <div className="home-logo">
        <div className="home-logo-mark">🏪</div>
        <h2>Oloolua Hardware</h2>
        <p>Stores Collection System</p>
      </div>

      <div className="scan-type-row">
        <button
          className={`scan-type-btn${scanType === 'printed' ? ' active' : ''}`}
          onClick={() => setScanType('printed')}
        >
          <span className="scan-type-icon">🧾</span>
          Printed Receipt
        </button>
        <button
          className={`scan-type-btn${scanType === 'handwritten' ? ' active' : ''}`}
          onClick={() => setScanType('handwritten')}
        >
          <span className="scan-type-icon">✍️</span>
          Handwritten Note
        </button>
      </div>

      <button className="btn-scan" onClick={onScan}>
        <span>📷</span> Scan
      </button>

      <div className="employee-row">
        <span>Employee:</span>
        <span className="employee-name" onClick={onEditEmployee}>
          {employee || 'tap to set'}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// CameraScreen
// ─────────────────────────────────────────────
function CameraScreen({ videoRef, fileRef, onCapture, onGallery, onFileChange, onBack }) {
  return (
    <div className="screen camera-screen">
      <div className="camera-viewport">
        <video ref={videoRef} autoPlay playsInline muted />
        <div className="camera-overlay">
          <div className="camera-guide" />
        </div>
      </div>
      <div className="camera-controls">
        <button className="btn-icon" onClick={onBack}>
          <span>←</span>
          <span>Back</span>
        </button>
        <button className="btn-capture" onClick={onCapture} aria-label="Capture photo" />
        <button className="btn-icon" onClick={onGallery}>
          <span>🖼️</span>
          <span>Gallery</span>
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={onFileChange}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// ProcessingScreen
// ─────────────────────────────────────────────
function ProcessingScreen({ image, text }) {
  return (
    <div className="screen processing-screen">
      {image && <img className="processing-img" src={image} alt="" />}
      <div className="spinner" />
      <p className="processing-text">{text}</p>
    </div>
  );
}

// ─────────────────────────────────────────────
// ReviewScreen
// ─────────────────────────────────────────────
function ReviewScreen({
  scan, editedScan, image, employee,
  dupeBanner, notes, onNotesChange,
  onFieldChange, onItemChange,
  onSubmit, onForceSubmit, onBack,
}) {
  const conf = scan?.confidence || {};
  const isPrinted = editedScan.receipt_type === 'printed';

  return (
    <div className="screen review-screen">
      <div className="topbar">
        <div>
          <h1>{isPrinted ? '🧾 Printed Receipt' : '✍️ Handwritten Note'}</h1>
          {editedScan.document_label && (
            <div className="topbar-sub">{editedScan.document_label}</div>
          )}
        </div>
        <button className="btn-icon" onClick={onBack} style={{ color: 'var(--text-muted)' }}>
          <span>✕</span>
        </button>
      </div>

      <div className="review-body">
        {image && <img className="review-image" src={image} alt="Scanned receipt" />}

        {dupeBanner && (
          <div className="dupe-banner">
            <span>⚠️</span>
            <div>
              <strong>Duplicate detected.</strong> {dupeBanner}
              <br />
              <button
                style={{
                  color: 'var(--danger)', background: 'none', border: 'none',
                  cursor: 'pointer', fontSize: '13px', padding: 0, marginTop: 6,
                }}
                onClick={onForceSubmit}
              >
                Submit anyway →
              </button>
            </div>
          </div>
        )}

        {isPrinted
          ? <PrintedFields scan={editedScan} conf={conf} onChange={onFieldChange} onItemChange={onItemChange} />
          : <HandwrittenFields scan={editedScan} conf={conf} onChange={onFieldChange} onItemChange={onItemChange} />
        }

        <div className="card">
          <div className="card-title">Notes</div>
          <div className="field-row">
            <textarea
              className="field-input"
              placeholder="Optional notes…"
              value={notes}
              onChange={e => onNotesChange(e.target.value)}
              rows={2}
              style={{ resize: 'none', width: '100%' }}
            />
          </div>
        </div>

        {employee && (
          <p style={{ textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)', paddingBottom: 4 }}>
            Submitting as <strong style={{ color: 'var(--gold)' }}>{employee}</strong>
          </p>
        )}
      </div>

      <div className="bottom-bar">
        <button className="btn-secondary" onClick={onBack}>Retake</button>
        <button className="btn-primary" onClick={onSubmit}>Submit</button>
      </div>
    </div>
  );
}

function PrintedFields({ scan, conf, onChange, onItemChange }) {
  return (
    <>
      <div className="card">
        <div className="card-title">Transaction</div>
        <EditableField label="Trnx Ref" value={scan.trnx_ref} confidence={conf.trnx_ref} onChange={v => onChange('trnx_ref', v)} />
        <EditableField label="Manual Marking" value={scan.manual_marking} confidence={null} onChange={v => onChange('manual_marking', v)} />
        <EditableField label="Salesperson" value={scan.salesperson} confidence={null} onChange={v => onChange('salesperson', v)} />
        {scan.narration && (
          <EditableField label="Narration" value={scan.narration} confidence={null} onChange={v => onChange('narration', v)} />
        )}
      </div>

      <div className="card">
        <div className="card-title">Sale Info</div>
        <EditableField label="Date" value={scan.date} confidence={null} onChange={v => onChange('date', v)} />
        <EditableField label="Time" value={scan.time} confidence={null} onChange={v => onChange('time', v)} />
        <EditableField label="Payment" value={scan.payment_method} confidence={null} onChange={v => onChange('payment_method', v)} />
        <EditableField label="Status" value={scan.status} confidence={null} onChange={v => onChange('status', v)} />
      </div>

      <div className="card">
        <div className="card-title">Items</div>
        <ItemsTable items={scan.items || []} onItemChange={onItemChange} conf={conf} />
        <div className="total-row">
          <span>Total</span>
          {conf.total && conf.total !== 'high' ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                className={`field-input${conf.total === 'low' ? ' warn' : ''}`}
                type="number"
                value={scan.total ?? ''}
                onChange={e => onChange('total', parseFloat(e.target.value) || 0)}
                style={{ width: 120, textAlign: 'right' }}
              />
              <ConfBadge level={conf.total} />
            </span>
          ) : (
            <span>KSh {Number(scan.total ?? 0).toLocaleString()}</span>
          )}
        </div>
        {scan.discount > 0 && (
          <div className="field-row">
            <span className="field-label">Discount</span>
            <span className="field-value">KSh {Number(scan.discount).toLocaleString()}</span>
          </div>
        )}
      </div>
    </>
  );
}

function HandwrittenFields({ scan, conf, onChange, onItemChange }) {
  return (
    <>
      <div className="card">
        <div className="card-title">Note Details</div>
        <EditableField label="Customer" value={scan.customer_name} confidence={conf.customer_name} onChange={v => onChange('customer_name', v)} />
        <EditableField label="Date" value={scan.date} confidence={null} onChange={v => onChange('date', v)} />
        <EditableField label="Salesperson" value={scan.salesperson} confidence={null} onChange={v => onChange('salesperson', v)} />
      </div>

      <div className="card">
        <div className="card-title">Items{conf.items && conf.items !== 'high' ? ' ' : ''}<ConfBadge level={conf.items} /></div>
        <HandwrittenItemsTable items={scan.items || []} onItemChange={onItemChange} />
      </div>
    </>
  );
}

// ─────────────────────────────────────────────
// EditableField — read-only by default, opens for editing on tap.
// Low/medium confidence fields open immediately.
// ─────────────────────────────────────────────
function EditableField({ label, value, confidence, onChange }) {
  const [editing, setEditing] = useState(confidence === 'low' || confidence === 'medium');

  if (editing) {
    return (
      <div className="field-row">
        <span className="field-label">{label}</span>
        <input
          className={`field-input${confidence === 'low' ? ' warn' : ''}`}
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
        />
        {confidence && confidence !== 'high' && <ConfBadge level={confidence} />}
      </div>
    );
  }

  return (
    <div className="field-row" onClick={() => setEditing(true)} style={{ cursor: 'pointer' }}>
      <span className="field-label">{label}</span>
      <span className={`field-value${!value ? ' null-val' : ''}`}>{value || '—'}</span>
      {confidence && confidence !== 'high' && <ConfBadge level={confidence} />}
    </div>
  );
}

// ─────────────────────────────────────────────
// Items tables (read-only — items are rarely wrong)
// ─────────────────────────────────────────────
function ItemsTable({ items, conf }) {
  if (!items.length) {
    return (
      <div className="field-row">
        <span className="field-value null-val">No items extracted</span>
        {conf?.items && <ConfBadge level={conf.items} />}
      </div>
    );
  }
  return (
    <table className="items-table">
      <thead>
        <tr>
          <th>Item</th>
          <th>Qty</th>
          <th className="amount">Amount</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, i) => (
          <tr key={i}>
            <td>{item.description}</td>
            <td className="qty">{item.qty ?? '—'}</td>
            <td className="amount">
              {item.amount != null ? `KSh ${Number(item.amount).toLocaleString()}` : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HandwrittenItemsTable({ items }) {
  if (!items.length) {
    return (
      <div className="field-row">
        <span className="field-value null-val">No items extracted</span>
      </div>
    );
  }
  return (
    <table className="items-table">
      <thead>
        <tr>
          <th>Item</th>
          <th>Qty</th>
          <th>Unit</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, i) => (
          <tr key={i}>
            <td>{item.description}</td>
            <td className="qty">{item.qty ?? '—'}</td>
            <td className="qty">{item.unit ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─────────────────────────────────────────────
// SuccessScreen
// ─────────────────────────────────────────────
function SuccessScreen({ data, onScanAnother }) {
  return (
    <div className="screen success-screen">
      <div className="success-icon">✅</div>
      <h2 className="success-title">Saved!</h2>
      {data?.trnx_ref && (
        <p className="success-ref">
          Trnx Ref: <strong>{data.trnx_ref}</strong>
        </p>
      )}
      {data?.flags?.length > 0 && (
        <p style={{ fontSize: '12px', color: 'var(--warn)', textAlign: 'center', maxWidth: 280 }}>
          ⚠️ {data.flags.join(' · ')}
        </p>
      )}
      <button className="btn-scan" onClick={onScanAnother} style={{ marginTop: 20 }}>
        <span>📷</span> Scan Another
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────
// ConfBadge
// ─────────────────────────────────────────────
function ConfBadge({ level }) {
  if (!level || level === 'high') return null;
  return <span className={`conf-badge conf-${level}`}>{level.toUpperCase()}</span>;
}

// ─────────────────────────────────────────────
// NameModal — bottom sheet to set/clear employee name
// ─────────────────────────────────────────────
function NameModal({ current, onSave, onCancel }) {
  const [name, setName] = useState(current || '');
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'flex-end', zIndex: 50,
    }}>
      <div style={{
        background: 'var(--surface)', width: '100%', maxWidth: 480,
        margin: '0 auto', borderRadius: '20px 20px 0 0',
        padding: '24px 20px 40px', display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <h3 style={{ fontFamily: 'var(--font-head)', fontSize: 17, color: 'var(--text)' }}>
          Your Name
        </h3>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: -8 }}>
          Optional — stored locally on this device.
        </p>
        <input
          className="field-input"
          placeholder="e.g. James"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSave(name)}
          autoFocus
        />
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
          <button className="btn-primary" style={{ flex: 2 }} onClick={() => onSave(name)}>Save</button>
        </div>
      </div>
    </div>
  );
}
