import { uuid } from '../uuid';
import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, recentCodes, useCart, useFetch, useI18n, useTenant } from '../lib';
import type { BranchInfo } from './Branches';

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="mb-3 block text-sm">
    <span className="mb-1 block font-medium">{label}</span>
    {children}
  </label>
);
const input = 'w-full rounded-lg border border-slate-400 bg-white px-3 py-2 text-base';

export default function Checkout() {
  const tenant = useTenant();
  const { branchId = '' } = useParams();
  const nav = useNavigate();
  const { t, pick, money } = useI18n();
  const { data: branches } = useFetch<BranchInfo[]>(`/store/${tenant}/branches`);
  const branch = branches?.find((b) => b.branchId === branchId);
  const cart = useCart(tenant, branchId);

  const [fulfilment, setFulfilment] = useState<'PICKUP' | 'DELIVERY'>('PICKUP');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [area, setArea] = useState('');
  const [address, setAddress] = useState('');
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState('');
  const [notes, setNotes] = useState('');
  const [method, setMethod] = useState<'CASH_ON_DELIVERY' | 'CARD_ONLINE'>('CASH_ON_DELIVERY');
  const [token, setToken] = useState('');
  const [simulateDecline, setSimulateDecline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // One key per checkout attempt, kept across reloads and network failures so a retry can never create a second order.
  // A declined payment voids that order on the server, so after a decline we start a fresh attempt (new key).
  const keyName = `sf_idem_${tenant}_${branchId}`;
  const idemKey = () => localStorage.getItem(keyName) ?? (localStorage.setItem(keyName, uuid()), localStorage.getItem(keyName)!);

  const fee = fulfilment === 'DELIVERY' ? Number(branch?.deliveryFee ?? 0) : 0;
  const total = cart.subtotal + fee;
  const belowMin = cart.subtotal < Number(branch?.minOrder ?? 0);

  // ponytail: stand-in for the payment gateway's hosted fields. A real gateway SDK replaces this step and returns a
  // token; card numbers must never be typed into, or sent through, this app. Tokens starting with DECLINE simulate a decline.
  const authorizeDemoPayment = () => setToken(`${simulateDecline ? 'DECLINE-' : 'tok_'}${uuid().slice(0, 8)}`);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api<{ trackingCode: string }>(`/store/${tenant}/orders`, {
        idempotencyKey: idemKey(),
        branchId,
        fulfilment,
        customer: { name: name.trim(), phone: phone.trim(), ...(email.trim() ? { email: email.trim() } : {}), consent },
        ...(fulfilment === 'DELIVERY' ? { address: { area, text: address.trim() } } : {}),
        ...(later && when ? { scheduledFor: new Date(when).toISOString() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: cart.lines.map((l) => ({ menuItemId: l.menuItemId, ...(l.variantId ? { variantId: l.variantId } : {}), ...(l.modifierIds.length ? { modifierIds: l.modifierIds } : {}), qty: l.qty })),
        payment: { method, ...(method === 'CARD_ONLINE' ? { token } : {}) },
      });
      localStorage.removeItem(keyName);
      cart.clear();
      recentCodes.add(tenant, res.trackingCode);
      nav(`/${tenant}/track/${res.trackingCode}?placed=1`);
    } catch (err) {
      const e2 = err as ApiError;
      if (e2.code === 'PAYMENT_DECLINED') {
        localStorage.removeItem(keyName);
        setToken('');
      }
      setError(e2.message);
    } finally {
      setBusy(false);
    }
  }

  if (cart.lines.length === 0) return <p>{t('Your cart is empty')} <Link className="text-brand-700 underline" to={`/${tenant}/b/${branchId}`}>{t('Back')}</Link></p>;

  return (
    <form onSubmit={submit} noValidate={false}>
      <Link to={`/${tenant}/b/${branchId}`} className="text-sm text-brand-700 underline">← {t('Back')}</Link>
      <h1 className="mb-3 mt-1 text-xl font-semibold">{t('Checkout')}</h1>

      <fieldset className="mb-4 flex gap-2">
        <legend className="sr-only">{t('Pickup')} / {t('Delivery')}</legend>
        {([['PICKUP', branch?.pickup], ['DELIVERY', branch?.delivery]] as const).map(([f, ok]) => (
          <label key={f} className={`flex-1 rounded-lg border px-3 py-2 text-center ${fulfilment === f ? 'border-brand-700 bg-brand-50 font-medium' : 'border-slate-300'} ${ok ? '' : 'opacity-40'}`}>
            <input type="radio" className="sr-only" name="fulfilment" disabled={!ok} checked={fulfilment === f} onChange={() => setFulfilment(f)} />
            {t(f === 'PICKUP' ? 'Pickup' : 'Delivery')}
          </label>
        ))}
      </fieldset>

      <Field label={t('Name')}><input className={input} required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
      <Field label={t('Phone')}><input className={input} required type="tel" minLength={7} maxLength={20} value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" /></Field>
      <Field label={t('Email')}><input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
      <label className="mb-1 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>{t('Save my details for next time')}</span>
      </label>
      <p className="mb-4 text-xs text-slate-600">If you tick this we keep your name and phone number to recognise you and add loyalty points. Without it, your details are used only to prepare and deliver this order.</p>

      {fulfilment === 'DELIVERY' && (
        <>
          <Field label={t('Area')}>
            <select className={input} required value={area} onChange={(e) => setArea(e.target.value)}>
              <option value="">{t('Select')}…</option>
              {branch?.serviceAreas.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
          <Field label={t('Address')}><textarea className={input} required maxLength={300} rows={2} value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" /></Field>
        </>
      )}

      {branch?.scheduledOrdering && (
        <div className="mb-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} />{t('Schedule for later')}</label>
          {later && <input aria-label={t('Schedule for later')} className={`${input} mt-2`} type="datetime-local" required min={new Date(Date.now() + (branch.prepMinutes + 1) * 60_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)} value={when} onChange={(e) => setWhen(e.target.value)} />}
        </div>
      )}

      <Field label={t('Notes')}><textarea className={input} rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>

      <fieldset className="mb-4">
        <legend className="mb-1 font-medium">{t('Payment')}</legend>
        {([['CASH_ON_DELIVERY', 'Cash on delivery / at pickup'], ['CARD_ONLINE', 'Card online']] as const).map(([m, label]) => (
          <label key={m} className="flex items-center gap-2 py-1.5"><input type="radio" name="pay" checked={method === m} onChange={() => setMethod(m)} />{t(label)}</label>
        ))}
        {method === 'CARD_ONLINE' && (
          <div className="mt-2 rounded-lg border-2 border-dashed border-amber-500 bg-amber-50 p-3 text-sm">
            <p className="font-semibold">Secure payment page (demo placeholder)</p>
            <p className="mb-2">A real payment gateway page replaces this step. Do not enter card numbers here; none are collected.</p>
            <label className="mb-2 flex items-center gap-2"><input type="checkbox" checked={simulateDecline} onChange={(e) => { setSimulateDecline(e.target.checked); setToken(''); }} />Simulate a declined card</label>
            <button type="button" onClick={authorizeDemoPayment} className="rounded-lg border border-slate-500 bg-white px-3 py-1.5">Authorize payment</button>
            {token && <p className="mt-2" role="status">Payment authorized (token {token}).</p>}
          </div>
        )}
      </fieldset>

      <div className="mb-3 space-y-1 border-t pt-3 text-sm">
        <div className="flex justify-between"><span>{t('Subtotal')}</span><span>{money(cart.subtotal)}</span></div>
        {fee > 0 && <div className="flex justify-between"><span>{t('Delivery fee')}</span><span>{money(fee)}</span></div>}
        <div className="flex justify-between text-base font-semibold"><span>{t('Total')}</span><span>{money(total)}</span></div>
        <ul className="pt-1 text-xs text-slate-600">{cart.lines.map((l) => <li key={l.key}>{l.qty}× {pick(l.name, l.nameAr)}</li>)}</ul>
      </div>

      {belowMin && <p role="alert" className="mb-2 rounded bg-amber-100 p-2 text-sm text-amber-900">{t('Minimum order')}: {money(branch?.minOrder ?? 0)}</p>}
      {error && <p role="alert" className="mb-2 rounded bg-red-50 p-3 text-red-800">{error}</p>}
      <button type="submit" disabled={busy || belowMin || (method === 'CARD_ONLINE' && !token) || (fulfilment === 'DELIVERY' && !area)} className="w-full rounded-xl bg-brand-700 py-3 font-medium text-white disabled:bg-slate-400">
        {t('Place order')} · {money(total)}
      </button>
    </form>
  );
}
