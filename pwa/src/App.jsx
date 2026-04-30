import { useState, useRef, useEffect } from 'react';
import { runOcr, saveScan, getStaff, uploadImage, getPendingCollections, markCollected } from './api.js';

function driveThumbnailUrl(driveUrl, size = 1000) {
  const m = driveUrl?.match(/\/d\/([^/]+)/);
  if (!m) return driveUrl;
  return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w${size}`;
}

function todayDDMMYYYY() {
  const d = new Date();
  return [d.getDate(), d.getMonth() + 1, d.getFullYear()]
    .map(n => String(n).padStart(2, '0')).join('-');
}
function nowHHMM() {
  const d = new Date();
  return [d.getHours(), d.getMinutes()].map(n => String(n).padStart(2, '0')).join(':');
}
// Resize a Blob to max `maxDim` px on the longest side, returns a new JPEG Blob
function resizeBlob(blob, maxDim = 2000) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(resolve, 'image/jpeg', 0.92);
    };
    img.src = url;
  });
}

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
  const [staffList, setStaffList] = useState([]);
  const [partialPickup, setPartialPickup] = useState(false);
  const [flowMode, setFlowMode] = useState('collect'); // 'collect' | 'authorize'
  const [pendingList, setPendingList] = useState([]);
  const [selectedPending, setSelectedPending] = useState(null);
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

  useEffect(() => {
    getStaff().then(res => {
      if (res?.staff) setStaffList(res.staff.map(s => s.name).filter(Boolean));
    }).catch(() => {});
  }, []);

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

    let rawBlob = null;

    // Try ImageCapture API — full sensor resolution
    const track = streamRef.current?.getVideoTracks()[0];
    if (track && typeof ImageCapture !== 'undefined') {
      try {
        const ic = new ImageCapture(track);
        rawBlob = await ic.takePhoto();
      } catch (err) {
        console.warn('ImageCapture failed, falling back to canvas:', err);
      }
    }

    if (!rawBlob) {
      // Fallback: canvas from video frame
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      rawBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.95));
    }

    // Resize to max 2000px — keeps OCR quality but avoids huge payloads
    const blob = await resizeBlob(rawBlob, 2000);

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const base64 = dataUrl.split(',')[1];
      setCapturedImage({ dataUrl, base64, mediaType: 'image/jpeg' });
      processImage(base64, 'image/jpeg', scanType);
    };
    reader.readAsDataURL(blob);
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
    const isAuthorize = flowMode === 'authorize';
    setProcessingText('Uploading image…');
    setScreen('processing');
    let drive_image_link;
    if (capturedImage?.base64) {
      const up = await uploadImage(
        capturedImage.base64,
        capturedImage.mediaType,
        editedScan?.trnx_ref,
        editedScan?.date,
      );
      if (up?.ok) drive_image_link = up.drive_link;
    }
    setProcessingText('Saving…');
    try {
      const payload = {
        scan: editedScan,
        stores_employee: isAuthorize ? undefined : (employee || undefined),
        notes: notes || undefined,
        drive_image_link,
        ...((force || partialPickup) && { force: true }),
        ...(isAuthorize ? { status: 'Pending' } : (partialPickup && { status: 'Partial' })),
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
      setSuccessData({
        trnx_ref: editedScan?.trnx_ref,
        flags: res.flags,
        sheetUrl: res.sheetUrl,
        sheetName: res.sheetName,
        mode: isAuthorize ? 'authorized' : 'collected',
      });
      setScreen('success');
    } catch {
      setScreen('review');
      showToast('Network error. Check your connection.');
    }
  };

  const openPendingList = async () => {
    setProcessingText('Loading pending collections…');
    setScreen('processing');
    const res = await getPendingCollections();
    if (!res?.ok) {
      showToast(res?.error || 'Failed to load pending list.');
      setScreen('home');
      return;
    }
    setPendingList(res.pending || []);
    setScreen('pending');
  };

  const handleMarkCollected = async () => {
    if (!selectedPending) return;
    if (!employee) {
      showToast('Please select your name first.');
      return;
    }
    setProcessingText('Marking as collected…');
    setScreen('processing');
    const res = await markCollected(selectedPending.sheetName, selectedPending.rowNum, employee);
    if (!res?.ok) {
      showToast(res?.error || 'Failed to mark collected.');
      setScreen('verify');
      return;
    }
    setSuccessData({
      flags: [],
      sheetUrl: res.sheetUrl,
      sheetName: res.sheetName,
      mode: 'collected',
      customer_name: selectedPending.customer_name,
    });
    setScreen('success');
  };

  const handleManualSubmit = async (manualScan, notes) => {
    setProcessingText('Saving…');
    setScreen('processing');
    try {
      const res = await saveScan({ scan: manualScan, stores_employee: employee || undefined, notes: notes || undefined });
      if (!res.ok && res.duplicate) {
        showToast('Duplicate Trnx Ref — already saved.');
        setScreen('manual');
        return;
      }
      if (!res.ok) {
        showToast(res.error || 'Save failed. Try again.');
        setScreen('manual');
        return;
      }
      setSuccessData({ trnx_ref: manualScan?.trnx_ref, flags: res.flags, sheetUrl: res.sheetUrl, sheetName: res.sheetName });
      setScreen('success');
    } catch {
      showToast('Network error. Check your connection.');
      setScreen('manual');
    }
  };

  const handleScanAnother = () => {
    setScan(null);
    setEditedScan(null);
    setCapturedImage(null);
    setDupeBanner(null);
    setSuccessData(null);
    setNotes('');
    setPartialPickup(false);
    setSelectedPending(null);
    setFlowMode('collect');
    setScreen('home');
  };

  return (
    <>
      {screen === 'home' && (
        <HomeScreen
          onScan={() => { setFlowMode('authorize'); setScreen('scanTypePicker'); }}
          onAuthorize={() => { setFlowMode('collect'); openPendingList(); }}
          onManual={() => { setScanType('handwritten'); setFlowMode('collect'); setScreen('manual'); }}
        />
      )}
      {screen === 'scanTypePicker' && (
        <ScanTypePickerScreen
          onPick={(type) => { setScanType(type); setScreen('camera'); }}
          onBack={() => setScreen('home')}
        />
      )}
      {screen === 'pending' && (
        <PendingListScreen
          pending={pendingList}
          onSelect={(p) => { setSelectedPending(p); setScreen('verify'); }}
          onBack={() => setScreen('home')}
          onRefresh={openPendingList}
        />
      )}
      {screen === 'verify' && selectedPending && (
        <VerifyScreen
          pending={selectedPending}
          employee={employee}
          onEmployeeChange={(name) => {
            setEmployee(name);
            name ? localStorage.setItem('employee', name) : localStorage.removeItem('employee');
          }}
          onConfirm={handleMarkCollected}
          onReject={() => { setSelectedPending(null); setScreen('pending'); }}
          onBack={() => { setSelectedPending(null); setScreen('pending'); }}
        />
      )}
      {screen === 'manual' && (
        <ManualEntryScreen
          scanType={scanType}
          employee={employee}
          staffList={staffList}
          onSubmit={handleManualSubmit}
          onBack={() => setScreen('home')}
        />
      )}
      {screen === 'camera' && (
        <CameraScreen
          scanType={scanType}
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
          flowMode={flowMode}
          scan={scan}
          editedScan={editedScan}
          image={capturedImage?.dataUrl}
          employee={employee}
          onEmployeeChange={(name) => {
            setEmployee(name);
            name ? localStorage.setItem('employee', name) : localStorage.removeItem('employee');
          }}
          staffList={staffList}
          dupeBanner={dupeBanner}
          notes={notes}
          onNotesChange={setNotes}
          partialPickup={partialPickup}
          onPartialPickupChange={setPartialPickup}
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
function HomeScreen({ onScan, onAuthorize, onManual }) {
  const cardStyle = {
    display: 'flex', alignItems: 'center', gap: 14,
    padding: '20px 18px', background: 'var(--surface)',
    border: '1px solid var(--border)', borderRadius: 16,
    width: '100%', textAlign: 'left', cursor: 'pointer',
    color: 'var(--text)', fontSize: 15,
  };
  const iconStyle = { fontSize: 32, lineHeight: 1 };
  const titleStyle = { fontWeight: 600, fontSize: 17 };
  const subStyle = { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 };

  return (
    <div className="screen home">
      <div className="home-logo">
        <img src="/logo.png" alt="Oloolua Hardware" className="home-logo-img" />
        <p>Stores Collection System</p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
        <button style={cardStyle} onClick={onScan}>
          <span style={iconStyle}>📷</span>
          <div>
            <div style={titleStyle}>Scan Receipt (Shop)</div>
            <div style={subStyle}>Salesperson logs a receipt or note</div>
          </div>
        </button>

        <button style={cardStyle} onClick={onAuthorize}>
          <span style={iconStyle}>✅</span>
          <div>
            <div style={titleStyle}>Authorize Collection (Stores)</div>
            <div style={subStyle}>Customer is here to collect</div>
          </div>
        </button>
      </div>

      <button className="btn-secondary" onClick={onManual} style={{ width: '100%', padding: '12px', borderRadius: 12, fontSize: 13, marginTop: 8 }}>
        ✏️ Enter Manually
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────
// ScanTypePickerScreen — printed or handwritten?
// ─────────────────────────────────────────────
function ScanTypePickerScreen({ onPick, onBack }) {
  const cardStyle = {
    display: 'flex', alignItems: 'center', gap: 14,
    padding: '20px 18px', background: 'var(--surface)',
    border: '1px solid var(--border)', borderRadius: 16,
    width: '100%', textAlign: 'left', cursor: 'pointer',
    color: 'var(--text)', fontSize: 15,
  };
  const iconStyle = { fontSize: 32, lineHeight: 1 };
  const titleStyle = { fontWeight: 600, fontSize: 17 };
  const subStyle = { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 };

  return (
    <div className="screen review-screen">
      <div className="topbar">
        <div>
          <h1>What are you scanning?</h1>
        </div>
        <button className="btn-icon" onClick={onBack} style={{ color: 'var(--text-muted)' }}>
          <span>←</span>
        </button>
      </div>

      <div className="review-body">
        <button style={cardStyle} onClick={() => onPick('printed')}>
          <span style={iconStyle}>🧾</span>
          <div>
            <div style={titleStyle}>Printed Receipt</div>
            <div style={subStyle}>From the Urovo POS</div>
          </div>
        </button>

        <button style={cardStyle} onClick={() => onPick('handwritten')}>
          <span style={iconStyle}>✍️</span>
          <div>
            <div style={titleStyle}>Handwritten Note</div>
            <div style={subStyle}>Collection note from a salesperson</div>
          </div>
        </button>
      </div>

      <div className="bottom-bar">
        <button className="btn-secondary" onClick={onBack} style={{ width: '100%' }}>← Back</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// PendingListScreen — store person sees today's pending
// ─────────────────────────────────────────────
function PendingListScreen({ pending, onSelect, onBack, onRefresh }) {
  return (
    <div className="screen review-screen">
      <div className="topbar">
        <div>
          <h1>📋 Pending Collections</h1>
          <div className="topbar-sub">{pending.length} awaiting collection</div>
        </div>
        <button className="btn-icon" onClick={onBack} style={{ color: 'var(--text-muted)' }}>
          <span>✕</span>
        </button>
      </div>

      <div className="review-body">
        {pending.length === 0 && (
          <div className="card" style={{ textAlign: 'center', padding: 32 }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✨</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>No pending collections</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              All authorized notes have been collected.
            </div>
          </div>
        )}

        {pending.map(p => (
          <button
            key={`${p.sheetName}-${p.rowNum}`}
            className="card"
            onClick={() => onSelect(p)}
            style={{ width: '100%', textAlign: 'left', cursor: 'pointer', border: '1px solid var(--border)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 16, color: 'var(--text)' }}>
                  {p.customer_name || (p.trnx_ref ? `Trnx ${p.trnx_ref}` : '(no name)')}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
                  {p.receipt_type === 'printed' ? '🧾' : '✍️'} by {p.salesperson || '—'} {p.sale_date && `· ${p.sale_date}`}
                </div>
                {p.item_summary && (
                  <div style={{
                    fontSize: 12, color: 'var(--text-muted)', marginTop: 6,
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  }}>
                    {p.item_summary}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 20, color: 'var(--gold)' }}>›</span>
            </div>
          </button>
        ))}
      </div>

      <div className="bottom-bar">
        <button className="btn-secondary" onClick={onRefresh}>↻ Refresh</button>
        <button className="btn-secondary" onClick={onBack}>Home</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// VerifyScreen — compare salesperson's photo with customer's note
// ─────────────────────────────────────────────
function VerifyScreen({ pending, employee, onEmployeeChange, onConfirm, onReject, onBack }) {
  const isPrinted = pending.receipt_type === 'printed';
  const headerLabel = pending.customer_name || (pending.trnx_ref ? `Trnx ${pending.trnx_ref}` : '(no name)');
  return (
    <div className="screen review-screen">
      <div className="topbar">
        <div>
          <h1>🔍 Verify {isPrinted ? 'Receipt' : 'Note'}</h1>
          <div className="topbar-sub">{headerLabel}</div>
        </div>
        <button className="btn-icon" onClick={onBack} style={{ color: 'var(--text-muted)' }}>
          <span>←</span>
        </button>
      </div>

      <div className="review-body">
        <div className="card" style={{ background: 'var(--surface2)', borderColor: 'var(--gold)' }}>
          <div style={{ fontSize: 12, color: 'var(--gold)', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Original from salesperson
          </div>
          {pending.drive_image_link ? (
            <a href={pending.drive_image_link} target="_blank" rel="noreferrer">
              <img
                src={driveThumbnailUrl(pending.drive_image_link, 1600)}
                alt="Original note"
                style={{ width: '100%', borderRadius: 8, display: 'block' }}
              />
            </a>
          ) : (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No image stored.
            </div>
          )}
          {pending.drive_image_link && (
            <a
              href={pending.drive_image_link}
              target="_blank" rel="noreferrer"
              style={{ display: 'block', textAlign: 'center', marginTop: 8, fontSize: 13, color: 'var(--gold)' }}
            >
              Open full size ↗
            </a>
          )}
        </div>

        <div className="card">
          <div className="card-title">Details</div>
          <div style={{ fontSize: 14, lineHeight: 1.7 }}>
            {pending.trnx_ref && <div><strong>Trnx Ref:</strong> {pending.trnx_ref}</div>}
            {pending.customer_name && <div><strong>Customer:</strong> {pending.customer_name}</div>}
            <div><strong>Salesperson:</strong> {pending.salesperson || '—'}</div>
            <div><strong>Sale date:</strong> {pending.sale_date || '—'}</div>
            {pending.item_summary && (
              <div style={{ marginTop: 6 }}><strong>Items:</strong> {pending.item_summary}</div>
            )}
            {pending.notes && (
              <div style={{ marginTop: 6 }}><strong>Notes:</strong> {pending.notes}</div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Stores Employee</div>
          <div className="field-row">
            <select
              className="field-input"
              value={employee}
              onChange={e => onEmployeeChange(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">— Select your name —</option>
              {STORES_EMPLOYEES.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{
          padding: '12px 14px', background: 'rgba(255,193,7,0.08)',
          border: '1px solid rgba(255,193,7,0.3)', borderRadius: 12,
          fontSize: 13, color: 'var(--text)',
        }}>
          ⚠️ <strong>Compare</strong> the original photo above with the customer's physical {isPrinted ? 'receipt' : 'note'}. Confirm only if they match.
        </div>
      </div>

      <div className="bottom-bar">
        <button className="btn-secondary" onClick={onReject} style={{ color: 'var(--danger)' }}>
          ✕ No Match
        </button>
        <button className="btn-primary" onClick={onConfirm}>
          ✓ Match — Collected
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// CameraScreen
// ─────────────────────────────────────────────
function CameraScreen({ scanType, videoRef, fileRef, onCapture, onGallery, onFileChange, onBack }) {
  const isHandwritten = scanType === 'handwritten';
  return (
    <div className="screen camera-screen">
      <div className="camera-viewport">
        <video ref={videoRef} autoPlay playsInline muted />
        <div className="camera-overlay">
          <div className={`camera-guide${isHandwritten ? ' camera-guide-wide' : ''}`} />
          {isHandwritten && (
            <div style={{
              position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
              background: 'rgba(0,0,0,0.65)', color: '#fff', padding: '6px 12px',
              borderRadius: 999, fontSize: 12, whiteSpace: 'nowrap',
            }}>
              Rotate phone landscape for wide notes
            </div>
          )}
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
const STORES_EMPLOYEES = ["King'ori", 'Maurine', 'Njoroge', 'Joel', 'Irene', 'Muteti'];

function ReviewScreen({
  flowMode = 'collect',
  scan, editedScan, image, employee, onEmployeeChange, staffList,
  dupeBanner, notes, onNotesChange,
  partialPickup, onPartialPickupChange,
  onFieldChange, onItemChange,
  onSubmit, onForceSubmit, onBack,
}) {
  const conf = scan?.confidence || {};
  const isPrinted = editedScan.receipt_type === 'printed';
  const isAuthorize = flowMode === 'authorize';

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

      {staffList?.length > 0 && (
        <datalist id="staff-datalist">
          {staffList.map(name => <option key={name} value={name} />)}
        </datalist>
      )}

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
          ? <PrintedFields scan={editedScan} conf={conf} onChange={onFieldChange} onItemChange={onItemChange} staffList={staffList} />
          : <HandwrittenFields scan={editedScan} conf={conf} onChange={onFieldChange} onItemChange={onItemChange} staffList={staffList} />
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

        {!isAuthorize && (
          <label
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 14px', background: 'var(--surface)',
              borderRadius: 12, border: '1px solid var(--border)',
              cursor: 'pointer', fontSize: 14, color: 'var(--text)',
            }}
          >
            <input
              type="checkbox"
              checked={partialPickup}
              onChange={e => onPartialPickupChange(e.target.checked)}
              style={{ width: 18, height: 18, accentColor: 'var(--gold)' }}
            />
            <span>Partial pickup <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>(customer collecting balance later)</span></span>
          </label>
        )}

        {!isAuthorize && (
          <div className="card">
            <div className="card-title">Stores Employee</div>
            <div className="field-row">
              <select
                className="field-input"
                value={employee}
                onChange={e => onEmployeeChange(e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="">— Select your name —</option>
                {STORES_EMPLOYEES.map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {isAuthorize && (
          <div style={{
            padding: '12px 14px', background: 'rgba(212,175,55,0.08)',
            border: '1px solid rgba(212,175,55,0.3)', borderRadius: 12,
            fontSize: 13, color: 'var(--text)',
          }}>
            🔒 This will be saved as <strong>Pending</strong>. The store will verify the customer's note against your photo before issuing goods.
          </div>
        )}
      </div>

      <div className="bottom-bar">
        <button className="btn-secondary" onClick={onBack}>Retake</button>
        <button className="btn-primary" onClick={onSubmit}>
          {isAuthorize ? 'Authorize' : 'Submit'}
        </button>
      </div>
    </div>
  );
}

function PrintedFields({ scan, conf, onChange, onItemChange, staffList }) {
  return (
    <>
      <div className="card">
        <div className="card-title">Transaction</div>
        <EditableField label="Trnx Ref" value={scan.trnx_ref} confidence={conf.trnx_ref} onChange={v => onChange('trnx_ref', v)} />
        <EditableField label="Manual Marking" value={scan.manual_marking} confidence={null} onChange={v => onChange('manual_marking', v)} />
        <EditableField label="Salesperson" value={scan.salesperson} confidence={null} onChange={v => onChange('salesperson', v)} staffList={staffList} />
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
      </div>
    </>
  );
}

function HandwrittenFields({ scan, conf, onChange, onItemChange, staffList }) {
  return (
    <>
      <div className="card">
        <div className="card-title">Note Details</div>
        <EditableField label="Customer" value={scan.customer_name} confidence={conf.customer_name} onChange={v => onChange('customer_name', v)} />
        <EditableField label="Date" value={scan.date} confidence={null} onChange={v => onChange('date', v)} />
        <EditableField label="Salesperson" value={scan.salesperson} confidence={null} onChange={v => onChange('salesperson', v)} staffList={staffList} />
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
function EditableField({ label, value, confidence, onChange, staffList }) {
  const [editing, setEditing] = useState(confidence === 'low' || confidence === 'medium');
  const hasStaff = staffList?.length > 0;

  if (editing) {
    return (
      <div className="field-row">
        <span className="field-label">{label}</span>
        <input
          className={`field-input${confidence === 'low' ? ' warn' : ''}`}
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          list={hasStaff ? 'staff-datalist' : undefined}
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
        </tr>
      </thead>
      <tbody>
        {items.map((item, i) => (
          <tr key={i}>
            <td>{item.description}</td>
            <td className="qty">{item.qty ?? '—'}</td>
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
  const sheetUrl = data?.sheetUrl || 'https://docs.google.com/spreadsheets/d/1b0YP4BfiPYAtN-zH6VkLWE0Uo-eI-MGQFSNad1JYFhg/edit';
  const isAuthorized = data?.mode === 'authorized';
  return (
    <div className="screen success-screen">
      <div className="success-icon">{isAuthorized ? '🔒' : '✅'}</div>
      <h2 className="success-title">{isAuthorized ? 'Authorized!' : 'Saved!'}</h2>
      {isAuthorized && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 280 }}>
          The store will verify the customer's note against your photo before issuing goods.
        </p>
      )}
      {data?.customer_name && (
        <p className="success-ref">
          Customer: <strong>{data.customer_name}</strong>
        </p>
      )}
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
      <a
        href={sheetUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          fontSize: '13px', color: 'var(--gold)', textDecoration: 'underline',
          textAlign: 'center', marginTop: 4,
        }}
      >
        📄 Open in Google Sheets{data?.sheetName ? ` (${data.sheetName})` : ''}
      </a>
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
// ManualEntryScreen
// ─────────────────────────────────────────────
function ManualEntryScreen({ scanType, employee, staffList, onSubmit, onBack }) {
  const [receiptType, setReceiptType] = useState(scanType || 'printed');
  const [salesperson, setSalesperson] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [date, setDate] = useState(todayDDMMYYYY());
  const [time, setTime] = useState(nowHHMM());
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [items, setItems] = useState([{ description: '', qty: '', unit: '' }]);
  const [notes, setNotes] = useState('');

  const addItem = () => setItems(p => [...p, { description: '', qty: '', amount: '', unit: '' }]);
  const removeItem = (i) => setItems(p => p.filter((_, idx) => idx !== i));
  const updateItem = (i, field, val) => setItems(p => {
    const next = [...p]; next[i] = { ...next[i], [field]: val }; return next;
  });

  const handleSubmit = () => {
    const cleanItems = items.filter(it => it.description.trim());
    const scan = receiptType === 'printed' ? {
      receipt_type: 'printed',
      document_label: 'MANUAL',
      salesperson: salesperson.trim() || null,
      date, time,
      payment_method: paymentMethod,
      status: 'paid',
      items: cleanItems.map(it => ({ description: it.description, qty: parseFloat(it.qty) || null })),
      confidence: { trnx_ref: 'high', total: 'high', items: 'high' },
    } : {
      receipt_type: 'handwritten',
      customer_name: customerName.trim() || null,
      salesperson: salesperson.trim() || null,
      date,
      items: cleanItems.map(it => ({ description: it.description, qty: parseFloat(it.qty) || null, unit: it.unit || null })),
      confidence: { customer_name: 'high', items: 'high' },
    };
    onSubmit(scan, notes);
  };

  return (
    <div className="screen review-screen">
      <div className="topbar">
        <h1>✏️ Manual Entry</h1>
        <button className="btn-icon" onClick={onBack} style={{ color: 'var(--text-muted)' }}>
          <span>✕</span>
        </button>
      </div>

      <div className="review-body">
        <div className="scan-type-row" style={{ marginBottom: 0 }}>
          <button className={`scan-type-btn${receiptType === 'printed' ? ' active' : ''}`} onClick={() => setReceiptType('printed')}>
            <span className="scan-type-icon">🧾</span>Printed
          </button>
          <button className={`scan-type-btn${receiptType === 'handwritten' ? ' active' : ''}`} onClick={() => setReceiptType('handwritten')}>
            <span className="scan-type-icon">✍️</span>Handwritten
          </button>
        </div>

        <div className="card">
          <div className="card-title">{receiptType === 'printed' ? 'Transaction' : 'Note Details'}</div>
          {receiptType === 'handwritten' && (
            <div className="field-row">
              <span className="field-label">Customer</span>
              <input className="field-input" value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Customer name" />
            </div>
          )}
          {staffList?.length > 0 && (
            <datalist id="staff-datalist">
              {staffList.map(name => <option key={name} value={name} />)}
            </datalist>
          )}
          <div className="field-row">
            <span className="field-label">Salesperson</span>
            <input className="field-input" value={salesperson} onChange={e => setSalesperson(e.target.value)} placeholder="Name" list={staffList?.length ? 'staff-datalist' : undefined} />
          </div>
          <div className="field-row">
            <span className="field-label">Date</span>
            <input className="field-input" value={date} onChange={e => setDate(e.target.value)} placeholder="DD-MM-YYYY" />
          </div>
          {receiptType === 'printed' && <>
            <div className="field-row">
              <span className="field-label">Time</span>
              <input className="field-input" value={time} onChange={e => setTime(e.target.value)} placeholder="HH:MM" />
            </div>
            <div className="field-row">
              <span className="field-label">Payment</span>
              <select className="field-input" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
                <option>Cash</option><option>Mpesa</option><option>Bank</option><option>other</option>
              </select>
            </div>
          </>}
        </div>

        <div className="card">
          <div className="card-title">Items</div>
          {items.map((item, i) => (
            <div key={i} style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input className="field-input" style={{ flex: 1 }} placeholder="Item description"
                  value={item.description} onChange={e => updateItem(i, 'description', e.target.value)} />
                {items.length > 1 && (
                  <button onClick={() => removeItem(i)}
                    style={{ background: 'none', border: 'none', color: 'var(--danger)', fontSize: 20, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}>×</button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="field-input" style={{ flex: 1 }} placeholder="Qty" type="number"
                  value={item.qty} onChange={e => updateItem(i, 'qty', e.target.value)} />
                <input className="field-input" style={{ flex: 1 }} placeholder="Unit (pcs/kg/rolls)"
                  value={item.unit} onChange={e => updateItem(i, 'unit', e.target.value)} />
              </div>
            </div>
          ))}
          <div style={{ padding: '10px 14px' }}>
            <button onClick={addItem}
              style={{ background: 'none', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', padding: '8px 16px', width: '100%', cursor: 'pointer', fontSize: 13 }}>
              + Add item
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Notes</div>
          <div className="field-row">
            <textarea className="field-input" placeholder="Optional notes…" value={notes}
              onChange={e => setNotes(e.target.value)} rows={2} style={{ resize: 'none', width: '100%' }} />
          </div>
        </div>

        {employee && (
          <p style={{ textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)', paddingBottom: 4 }}>
            Submitting as <strong style={{ color: 'var(--gold)' }}>{employee}</strong>
          </p>
        )}
      </div>

      <div className="bottom-bar">
        <button className="btn-secondary" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={handleSubmit}>Submit</button>
      </div>
    </div>
  );
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
