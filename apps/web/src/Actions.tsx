import { CourierMap } from './CourierMap';
import{useEffect,useRef,useState,type FormEvent}from'react';import{Medal,Plus,Target,Trophy,Users,X}from'lucide-react';import{api,latestDashboardData}from'./api';import{VolumeIcon}from'./design-system';
type Row=Record<string,unknown>;type List={items:Row[]};

type VolumeDraft = { id?: string; name: string; iconKey: string };

export function VolumeCatalog({items, refresh}: {items: Row[]; refresh: () => void}) {
  const [draft, setDraft] = useState<VolumeDraft | null>(null);
  const [suggestions, setSuggestions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);

  function openEditor(volume: VolumeDraft) {
    setDraft(volume);
    setError('');
    dialog.current?.showModal();
  }

  async function save(archive = false) {
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    try {
      const path = '/tenant/delivery-items' + (draft.id ? '/' + draft.id : '');
      await api(path, { method: draft.id ? 'PATCH' : 'POST',
        body: JSON.stringify(archive ? { archived: true } : { name: draft.name.trim(), iconKey: draft.iconKey }),
      });
      dialog.current?.close();
      refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="volume-catalog">
    <div className="volume-catalog-actions">
      <button onClick={() => openEditor({name:'',iconKey:'box'})}>+ Novo volume</button>
      <button className="secondary-action" aria-expanded={suggestions} onClick={() => setSuggestions(!suggestions)}>Volumes comuns</button>
    </div>
    {suggestions && <section className="volume-presets"><h2>Sugestões de volumes</h2><div className="preset-grid">
      {volumePresets.map(preset => {
        const exists = items.some(item => String(item.name).toLocaleLowerCase('pt-BR') === preset.name.toLocaleLowerCase('pt-BR'));
        return <button key={preset.iconKey} disabled={exists} onClick={() => openEditor(preset)}>
          <VolumeIcon iconKey={preset.iconKey}/>{preset.name}{exists && <small>Já cadastrado</small>}
        </button>;
      })}
    </div></section>}
    <h2>Volumes cadastrados</h2>
    {items.length === 0 && <p>Nenhum volume cadastrado.</p>}
    {items.map(item => <div key={String(item.id)} className="volume-catalog-row">
      <span><VolumeIcon iconKey={item.icon_key}/> {String(item.name)}</span>
      <button className="secondary-action" aria-label={`Editar ${item.name}`} onClick={() =>
        openEditor({id:String(item.id),name:String(item.name),iconKey:String(item.icon_key)})}>Editar</button>
    </div>)}
    <dialog className="volume-dialog" ref={dialog} aria-labelledby="volume-title" onClose={() => setDraft(null)}
      onCancel={event => { if (busy) event.preventDefault(); }}>
      {draft && <form className="editor" onSubmit={event => {event.preventDefault();void save();}}>
        <h2 id="volume-title">{draft.id ? 'Editar volume' : 'Novo volume'}</h2>
        <label>Nome do volume<input autoFocus required maxLength={100} value={draft.name} onChange={event => setDraft({...draft,name:event.target.value})}/></label>
        <fieldset className="volume-glyph-picker"><legend>Ícone do volume</legend><div>
          {Object.entries(volumeIcons).map(([key,label]) => <label key={key}>
            <input type="radio" name="iconKey" checked={draft.iconKey === key} onChange={() => setDraft({...draft,iconKey:key})}/>
            <VolumeIcon iconKey={key}/>{label}
          </label>)}
        </div></fieldset>
        {error && <p className="alert" role="alert">{error}</p>}
        <div className="volume-catalog-actions">
          <button disabled={busy || !draft.name.trim()}>Salvar volume</button>
          <button type="button" disabled={busy} className="secondary-action" onClick={() => dialog.current?.close()}>Cancelar</button>
          {draft.id && <button type="button" disabled={busy} className="danger" onClick={() => void save(true)}>Arquivar</button>}
        </div>
      </form>}
    </dialog>
  </section>;
}
const deliveryStatuses:Record<string,string>={pending:'Pendente',assigned:'Atribuída',in_progress:'Em rota',problem:'Problema registrado',completed:'Concluída',cancelled:'Cancelada'};
const eventKinds:Record<string,string>={created:'Criada',assigned:'Atribuída',reassigned:'Reatribuída',viewed:'Visualizada',check_in:'Check-in',completed:'Concluída',problem:'Problema registrado',cancelled:'Cancelada',note:'Atualizada'};
const volumeIcons:Record<string,string>={market:'Feira',gas:'Gás',water:'Água',box:'Caixa',food:'Alimento',medicine:'Medicamento',document:'Documento',other:'Outro'};
const volumePresets=[{name:'Feira',iconKey:'market'},{name:'Botijão de gás',iconKey:'gas'},{name:'Galão de água 20 L',iconKey:'water'},{name:'Caixa',iconKey:'box'},{name:'Alimentos',iconKey:'food'},{name:'Medicamentos',iconKey:'medicine'},{name:'Documentos',iconKey:'document'},{name:'Outro volume',iconKey:'other'}];
function destinationText(value:unknown){if(!value||typeof value!=='object')return '—';const address=value as Row;return ['street','number','complement','neighborhood','city','state','postal_code'].map(key=>address[key]).filter(part=>typeof part==='string'&&part).join(', ')||'—'}
function eventDate(value:unknown){if(!value)return '—';const date=new Date(String(value));return Number.isNaN(date.getTime())?'—':date.toLocaleString('pt-BR',{timeZone:'America/Fortaleza'})}
type Field={key:string;label:string;required?:boolean;type?:string;options?:{value:string;label:string}[]};
const specs:Record<string,{path:string;title:string;fields:Field[]}>= {
 customers:{path:'/tenant/customers',title:'Novo cliente',fields:[{key:'name',label:'Nome',required:true},{key:'phone',label:'Telefone'},{key:'email',label:'E-mail',type:'email'},{key:'notes',label:'Observações'}]},
 addresses:{path:'/tenant/addresses',title:'Novo endereço',fields:[{key:'customerId',label:'Cliente',required:true},{key:'label',label:'Identificação'},{key:'street',label:'Rua',required:true},{key:'number',label:'Número'},{key:'neighborhood',label:'Bairro'},{key:'city',label:'Cidade',required:true},{key:'state',label:'UF',required:true},{key:'postalCode',label:'CEP'}]},
  deliveries:{path:'/deliveries',title:'Nova entrega',fields:[{key:'customerId',label:'Cliente',required:true},{key:'addressId',label:'Endereço salvo'},{key:'instructions',label:'Instruções'},{key:'estimatedEarningsCents',label:'Valor estimado (centavos)',type:'number'},{key:'courierMembershipId',label:'Entregador'}]},
 users:{path:'/tenant/invites',title:'Convidar usuário',fields:[{key:'email',label:'E-mail',type:'email',required:true},{key:'role',label:'Papel',required:true,options:[{value:'courier',label:'Entregador'},{value:'admin',label:'Administrador'}]}]},
 tenants:{path:'/platform/tenants',title:'Nova empresa',fields:[{key:'name',label:'Nome',required:true},{key:'adminEmail',label:'E-mail do administrador',type:'email',required:true},{key:'legalName',label:'Razão social'},{key:'cnpj',label:'CNPJ'},{key:'contactEmail',label:'E-mail de contato'}]},
 plans:{path:'/platform/plans',title:'Novo plano',fields:[{key:'name',label:'Nome',required:true},{key:'maxCouriers',label:'Máximo de entregadores',type:'number'},{key:'maxUsers',label:'Máximo de usuários',type:'number'},{key:'maxMonthlyDeliveries',label:'Entregas por mês',type:'number'},{key:'maxStorageBytes',label:'Armazenamento em bytes',type:'number'}]},
 subscriptions:{path:'/platform/subscriptions',title:'Nova assinatura',fields:[{key:'tenantId',label:'Empresa',required:true},{key:'planId',label:'Plano',required:true},{key:'notes',label:'Observações'}]}
};
const choicePaths: Record<string, string> = {
  customerId: '/tenant/customers',
  addressId: '/tenant/addresses',
  courierMembershipId: '/tenant/users?role=courier&status=active',
  tenantId: '/platform/tenants',
  planId: '/platform/plans',
};

async function loadChoiceItems(path: string): Promise<Row[]> {
  const items: Row[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const url = `${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page: List & { nextCursor?: string | null } = await api(url);
    items.push(...page.items);
    cursor = page.nextCursor ?? null;
    if (cursor) {
      if (seen.has(cursor)) throw new Error('A lista de opções repetiu uma página. Tente novamente.');
      seen.add(cursor);
    }
  } while (cursor);
  return items;
}

function CustomerAutocomplete({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const selected = items.find(item => String(item.id) === value);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2 || value) {
      setItems(value ? items : []);
      setLoading(false);
      setError('');
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    const timer = window.setTimeout(() => {
      api<List>(`/tenant/customers?search=${encodeURIComponent(text)}&limit=20`)
        .then(result => { if (requestId.current === id) setItems(result.items); })
        .catch(e => { if (requestId.current === id) { setItems([]); setError((e as Error).message); } })
        .finally(() => { if (requestId.current === id) setLoading(false); });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, value]);

  function select(item: Row) {
    onChange(String(item.id));
    setQuery('');
    setItems([item]);
  }

  function clear() {
    onChange('');
    setQuery('');
    setItems([]);
  }

  return <div className="customer-autocomplete">
    <input type="hidden" name="customerId" value={value} required aria-hidden="true" />
    {selected ? <div className="selected-customer"><span>{choiceLabel(selected)}</span><button type="button" onClick={clear} aria-label="Limpar cliente">Limpar</button></div> : <>
      <input value={query} onChange={event => { setQuery(event.target.value); if (value) onChange(''); }} placeholder="Nome, telefone ou e-mail" autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={query.trim().length >= 2} aria-controls="customer-results" />
      {query.trim().length > 0 && query.trim().length < 2 && <small>Digite pelo menos 2 caracteres.</small>}
      {loading && <small role="status">Buscando clientes…</small>}
      {error && <div className="alert" role="alert">{error}</div>}
      {!loading && !error && query.trim().length >= 2 && items.length === 0 && <small>Nenhum cliente encontrado.</small>}
      {items.length > 0 && <div id="customer-results" role="listbox" className="customer-results">{items.map(item => <button type="button" role="option" key={String(item.id)} onClick={() => select(item)}>{choiceLabel(item)}{item.phone || item.email ? <small>{[item.phone, item.email].filter(Boolean).join(' · ')}</small> : null}</button>)}</div>}
    </>}
  </div>;
}

function choiceLabel(row: Row): string {
  const personOrOrg = row.name ?? row.full_name ?? row.email;
  if (personOrOrg) return String(personOrOrg);
  if (row.street) return [row.label, [row.street, row.number].filter(Boolean).join(', '), row.neighborhood, [row.city, row.state].filter(Boolean).join('/')].filter(Boolean).join(' · ');
  return String(row.label ?? row.id ?? 'Registro');
}

export function Actions({ section, filtersOpen, refresh }: { section: string; filtersOpen?: boolean; refresh: () => void }) {
  const spec = specs[section];
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [choiceError, setChoiceError] = useState('');
  const [reloadChoices, setReloadChoices] = useState(0);
  const [result, setResult] = useState<Row | null>(null);
  const [toast, setToast] = useState('');
  const [choices, setChoices] = useState<Record<string, Row[]>>({});
  const [loadingChoices, setLoadingChoices] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [inlineAddress,setInlineAddress]=useState(false);
  const [claimable,setClaimable]=useState(false);
  const [localities,setLocalities]=useState<Row[]>([]);
  const [volumeOptions,setVolumeOptions]=useState<Row[]>([]);
  const [selectedVolumes,setSelectedVolumes]=useState<Record<string,string>>({});
  const [reportFrom,setReportFrom]=useState('');
  const [reportTo,setReportTo]=useState('');
  const [reportCourier,setReportCourier]=useState('');
  const [reportCouriers,setReportCouriers]=useState<Row[]>([]);
  const [reportNeighborhood,setReportNeighborhood]=useState('');
  const [reportHourFrom,setReportHourFrom]=useState('');
  const [reportHourTo,setReportHourTo]=useState('');
  const modalRef=useRef<HTMLFormElement|null>(null);
  const triggerRef=useRef<HTMLButtonElement|null>(null);

  useEffect(() => {
    if (!open || !spec) return;
    let active = true;
    const keys = spec.fields.map(field => field.key).filter(key => key in choicePaths && !(section === 'deliveries' && key === 'customerId'));
    setChoices({});
    setError('');
    setChoiceError('');
    setLoadingChoices(keys.length > 0 || section==='deliveries');
    Promise.all([Promise.all(keys.map(async key => [key, await loadChoiceItems(choicePaths[key])] as const)),section==='deliveries'?loadChoiceItems('/tenant/delivery-items'):Promise.resolve([] as Row[])])
      .then(([entries,volumes]) => { if (active) {setChoices(Object.fromEntries(entries));setVolumeOptions(volumes);} })
      .catch(e => { if (active) setChoiceError((e as Error).message); })
      .finally(() => { if (active) setLoadingChoices(false); });
    return () => { active = false; };
  }, [open, section, reloadChoices]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(()=>{if(open&&['addresses','deliveries'].includes(section))api<List>('/tenant/localities?limit=200').then(r=>setLocalities(r.items)).catch(()=>setLocalities([]));},[open,section]);
  useEffect(()=>{
    if(!open||section!=='deliveries')return;
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    requestAnimationFrame(()=>modalRef.current?.querySelector<HTMLElement>('input:not([type="checkbox"]),select,textarea')?.focus());
    const handleModalKeys=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();closeEntry();return;}
      if(event.key!=='Tab')return;
      const focusable=Array.from(modalRef.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')??[]);
      if(!focusable.length){event.preventDefault();return;}
      const first=focusable[0]!,last=focusable.at(-1)!,active=document.activeElement;
      if(!modalRef.current?.contains(active)){event.preventDefault();first.focus();}
      else if(event.shiftKey&&active===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&active===last){event.preventDefault();first.focus();}
    };
    document.addEventListener('keydown',handleModalKeys);
    return()=>{
      document.removeEventListener('keydown',handleModalKeys);
      document.body.style.overflow=previousOverflow;
      requestAnimationFrame(()=>triggerRef.current?.focus());
    };
  },[open,section]);

  const [chosenStreet,setChosenStreet] = useState({name:'',version:0});
  useEffect(() => {
    if (section !== 'addresses') return;
    const selectStreet = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      setChosenStreet(previous => ({name,version:previous.version+1}));
      setError('');
      setResult(null);
      setOpen(true);
      requestAnimationFrame(() => modalRef.current?.scrollIntoView({block:'start'}));
    };
    window.addEventListener('entregaja:use-street',selectStreet);
    return () => window.removeEventListener('entregaja:use-street',selectStreet);
  },[section]);
  function resetEntry(){setChosenStreet({name:'',version:0});setCustomerId('');setInlineAddress(false);setClaimable(false);setSelectedVolumes({});}
  function openEntry(){resetEntry();setError('');setResult(null);setOpen(true);}
  function closeEntry(){setOpen(false);resetEntry();}
  useEffect(()=>{setOpen(false);resetEntry();setResult(null);},[section]);
  useEffect(()=>{
    if(section!=='deliveries')return;
    loadChoiceItems('/tenant/users?role=courier&status=active').then(setReportCouriers).catch(()=>setReportCouriers([]));
  },[section]);

  if(section==='dashboard') return <><LiveOperationMap/><Heatmap/></>;
  if(section==='gamification') return <GamificationPanel refresh={refresh}/>;
  if (!spec) return null;
  const missingRequiredChoice = spec.fields.some(field =>
    field.required && field.key in choicePaths && !(section === 'deliveries' && field.key === 'customerId') && !choices[field.key]?.length);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!spec || loadingChoices || missingRequiredChoice || choiceError) return;
    setError('');
    const form = new FormData(event.currentTarget);
    const body: Row = {};
    for (const field of spec.fields) {
      const value = String(form.get(field.key) ?? '').trim();
      if (value) body[field.key] = field.type === 'number' ? Number(value) : value;
    }
    if(section==='deliveries'){
      body.claimable=claimable;if(body.claimable)delete body.courierMembershipId;
      body.items=Object.entries(selectedVolumes).filter(([,quantity])=>Number(quantity)>0).map(([catalogItemId,quantity])=>({catalogItemId,quantity:Number(quantity)}));
      if(!(body.items as Row[]).length){setError('Selecione ao menos um volume para a entrega.');return;}
      if(inlineAddress){delete body.addressId;body.address={label:String(form.get('new_label')??'').trim(),street:String(form.get('new_street')??'').trim(),number:String(form.get('new_number')??'').trim(),complement:String(form.get('new_complement')??'').trim(),neighborhood:String(form.get('new_neighborhood')??'').trim(),city:String(form.get('new_city')??'').trim(),state:String(form.get('new_state')??'').trim().toUpperCase(),postalCode:String(form.get('new_postalCode')??'').trim()};}
      else if(!body.addressId){setError('Selecione um endereço ou cadastre um novo nesta entrega.');return;}
    }
    try {
      const response = await api<Row>(spec.path, { method: 'POST', body: JSON.stringify(body) });
      setResult(response);
      setToast('Registro salvo.');
      refresh();
      closeEntry();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function renderField(field: Field) {
    if (field.options) return <select name={field.key} required={field.required}>
      {field.options.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
    </select>;
    if (field.key in choicePaths) {
      if (section === 'deliveries' && field.key === 'customerId') return <CustomerAutocomplete value={customerId} onChange={setCustomerId} />;
      if(section==='deliveries'&&field.key==='addressId'&&inlineAddress)return null;
      if(section==='deliveries'&&field.key==='courierMembershipId'&&claimable)return <span>Será escolhido pelo primeiro entregador que aceitar.</span>;
      const available = field.key === 'addressId' && customerId
        ? (choices[field.key] ?? []).filter(row => String(row.customer_id) === customerId)
        : (choices[field.key] ?? []);
      return <select key={field.key === 'addressId' ? customerId : field.key} name={field.key}
        defaultValue={field.key === 'addressId' && available.length === 1 ? String(available[0].id ?? available[0].membership_id) : ''}
        required={field.required} disabled={loadingChoices || !!choiceError}
        onChange={field.key === 'customerId' ? event => setCustomerId(event.target.value) : undefined}>
        <option value="">{available.length === 1 && field.key === 'addressId' ? 'Endereço selecionado' : available.length ? 'Selecione' : 'Nenhuma opção disponível'}</option>
        {available.map(row => <option key={String(row.id ?? row.membership_id)}
          value={String(row.id ?? row.membership_id)}>
          {choiceLabel(row)}
        </option>)}
      </select>;
    }
    if(['street','neighborhood','city'].includes(field.key))return <><input name={field.key} type={field.type??'text'} required={field.required} list={`localities-${field.key}`}/><datalist id={`localities-${field.key}`}>{localities.filter(x=>!x.category||(field.key==='street'?x.category==='street':field.key==='neighborhood'?x.category==='neighborhood':x.category==='locality')).map((x,i)=><option key={`${x.name}-${i}`} value={String(x.name)}/>)}</datalist></>;
    return <input name={field.key} type={field.type ?? 'text'} required={field.required}/>;
  }

  async function exportDeliveries(){try{const params=new URLSearchParams();if(reportFrom)params.set('from',reportFrom);if(reportTo)params.set('to',reportTo);if(reportCourier)params.set('courierMembershipId',reportCourier);if(reportNeighborhood)params.set('neighborhood',reportNeighborhood);if(reportHourFrom)params.set('hourFrom',reportHourFrom);if(reportHourTo)params.set('hourTo',reportHourTo);const response=await fetch(`/v1/tenant/reports/deliveries.csv${params.toString()?`?${params}`:''}`,{credentials:'include'});if(!response.ok)throw new Error();const blob=await response.blob();const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='entregas.csv';link.click();URL.revokeObjectURL(url)}catch{setError('Não foi possível exportar o relatório agora.')}}
  return <>
    {section==='deliveries'&&filtersOpen&&<><div className="report-filters" aria-label="Filtros do relatório"><label>De<input type="date" value={reportFrom} onChange={event=>setReportFrom(event.target.value)}/></label><label>Até<input type="date" value={reportTo} onChange={event=>setReportTo(event.target.value)}/></label><label>Entregador<select value={reportCourier} onChange={event=>setReportCourier(event.target.value)}><option value="">Todos</option>{reportCouriers.map(courier=><option key={String(courier.membership_id)} value={String(courier.membership_id)}>{String(courier.full_name??courier.email)}</option>)}</select></label><label>Bairro<input value={reportNeighborhood} onChange={event=>setReportNeighborhood(event.target.value)} placeholder="Todos"/></label><label>Hora inicial<input type="number" min="0" max="23" value={reportHourFrom} onChange={event=>setReportHourFrom(event.target.value)} placeholder="0"/></label><label>Hora final<input type="number" min="0" max="23" value={reportHourTo} onChange={event=>setReportHourTo(event.target.value)} placeholder="23"/></label></div><button type="button" className="secondary-action" onClick={exportDeliveries}>Exportar CSV filtrado</button><button type="button" className="secondary-action" onClick={()=>window.print()}>Exportar PDF</button></>}
    {!(open&&section==='deliveries')&&<button ref={triggerRef} className="action-trigger" type="button" onClick={() => open?closeEntry():openEntry()}>
      {open?<X size={16} aria-hidden="true"/>:<Plus size={16} aria-hidden="true"/>}{open ? 'Fechar' : spec.title}
    </button>}
    {open&&section==='deliveries'&&<button type="button" className="delivery-modal-backdrop" aria-label="Fechar cadastro de entrega" onClick={closeEntry}/>}
    {open && <form ref={modalRef} className={`editor${section==='deliveries'?' delivery-editor-modal':''}`} role={section==='deliveries'?'dialog':undefined} aria-modal={section==='deliveries'?true:undefined} aria-labelledby={section==='deliveries'?'delivery-form-title':undefined} onSubmit={submit}>
      <div className="entry-heading"><h2 id={section==='deliveries'?'delivery-form-title':undefined}>{spec.title}</h2>
        {section==='deliveries'&&<button type="button" className="modal-dismiss" onClick={closeEntry}>Fechar</button>}
      </div>
      {loadingChoices && <p>Carregando opções…</p>}
      {section === 'addresses' && <AddressLookup/>}
      <div className="fields">{spec.fields.map(field => {
        if (section === 'addresses' && field.key === 'street') return <StreetField key={chosenStreet.version} name="street" initialStreet={chosenStreet.name}/>;
        if (section === 'deliveries' && field.key === 'addressId') return <div key={field.key} className="delivery-choice-group">
          {!inlineAddress && <label>{field.label}{renderField(field)}</label>}
        <label className="inline-toggle"><input type="checkbox" checked={inlineAddress} onChange={e=>setInlineAddress(e.target.checked)}/> Cadastrar novo endereço</label>
        {inlineAddress && <AddressLookup prefix="new_"/>}
        {inlineAddress&&<div className="fields">{[['new_label','Identificação'],['new_street','Rua'],['new_number','Número'],['new_complement','Complemento'],['new_neighborhood','Bairro'],['new_city','Cidade'],['new_state','UF'],['new_postalCode','CEP']].map(([name,label])=>name==='new_street'?<StreetField name={name} key={name}/>:<label key={name}>{label}<input name={name} required={['new_street','new_city','new_state'].includes(name)} list={['new_street','new_neighborhood','new_city'].includes(name)?`localities-${name}`:undefined}/>{['new_street','new_neighborhood','new_city'].includes(name)&&<datalist id={`localities-${name}`}>{localities.filter(x=>name==='new_street'?x.category==='street':name==='new_neighborhood'?x.category==='neighborhood':x.category==='locality').map((x,i)=><option key={`${x.name}-${i}`} value={String(x.name)}/>)}</datalist>}</label>)}</div>}
        </div>;
        if (section === 'deliveries' && field.key === 'courierMembershipId') return <div key={field.key} className="delivery-choice-group">
          <label>{field.label}{renderField(field)}</label>
        <label className="inline-toggle"><input type="checkbox" checked={claimable} onChange={e=>setClaimable(e.target.checked)}/> Disponível para quem aceitar primeiro</label>
        </div>;
        return <label key={field.key}>{field.label}{renderField(field)}</label>;
      })}</div>
      {section==='deliveries'&&<>
        <section className="volume-picker"><div className="volume-picker-heading"><div><h3>Volumes da entrega</h3><p>Selecione os itens e informe a quantidade.</p></div><span>{Object.values(selectedVolumes).filter(q=>Number(q)>0).length} selecionado(s)</span></div>{volumeOptions.length===0?<p className="empty-hint">O catálogo está vazio. Cadastre seus volumes na seção <b>Volumes</b> antes de criar a entrega.</p>:<div className="volume-options">{volumeOptions.map(volume=>{const id=String(volume.id);const selected=selectedVolumes[id]!==undefined;return <div className={`volume-option${selected?' selected':''}`} key={id}><label><input type="checkbox" checked={selected} onChange={event=>setSelectedVolumes(current=>{const next={...current};if(event.target.checked)next[id]='1';else delete next[id];return next})}/><span className="volume-icon"><VolumeIcon iconKey={volume.icon_key}/></span><span className="volume-name">{String(volume.name)}</span></label>{selected&&<label className="volume-quantity">Qtd.<input aria-label={`Quantidade de ${String(volume.name)}`} type="number" min="1" max="999" value={selectedVolumes[id]} onChange={event=>setSelectedVolumes(current=>({...current,[id]:event.target.value}))}/></label>}</div>})}</div>}</section>
      </>}
      <button type="submit" disabled={loadingChoices || missingRequiredChoice || !!choiceError}>{section==='deliveries'?'Criar entrega':'Salvar'}</button>
      {choiceError && <div className="alert">{choiceError} <button type="button" onClick={() => setReloadChoices(value => value + 1)}>Tentar novamente</button></div>}
      {error && <div className="alert">{error}</div>}
    </form>}
    {section==='addresses'&&<details><summary>Configurar área de operação</summary><OperationArea/></details>}
    {toast && result && <div className="toast" role="status">{toast}
      {typeof (result.adminInvite as Row | undefined)?.token === 'string' || typeof result.token === 'string'
        ? <p>Link de acesso: <a href={inviteLink(String((result.adminInvite as Row | undefined)?.token ?? result.token))}>
          {inviteLink(String((result.adminInvite as Row | undefined)?.token ?? result.token))}
        </a></p> : null}
    </div>}
  </>;
}

function OperationArea(){const[message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setBusy(true);setError('');setMessage('');const f=new FormData(e.currentTarget);try{const r=await api<{imported:number}>('/tenant/localities/import',{method:'POST',body:JSON.stringify({location:String(f.get('location')),radiusM:Number(f.get('radiusM'))})});window.dispatchEvent(new Event('entregaja:streets-imported'));setMessage(`${r.imported} ruas e localidades importadas.`)}catch(err){setError((err as Error).message)}finally{setBusy(false)}}return <section className="location-editor"><h3>Área de operação</h3><p>Importe ruas e localidades próximas para sugerir no cadastro de endereços.</p><form onSubmit={submit}><label>Endereço, cidade e estado<input name="location" required placeholder="Centro, Fortaleza, CE"/></label><label>Raio de busca<select name="radiusM" defaultValue="2000">{[500,1000,2000,3000,5000].map(n=><option value={n} key={n}>{n>=1000?`${n/1000} km`:`${n} m`}</option>)}</select></label><button disabled={busy}>{busy?'Importando…':'Importar ruas e bairros próximos'}</button></form><small>Dados <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors · ODbL</a></small>{message&&<div className="notice">{message}</div>}{error&&<div className="alert">{error}</div>}</section>}


export function DeliveryDetail({id,onClose,refresh}:{id:string;onClose:()=>void;refresh:()=>void}){const[data,setData]=useState<Row|null>(null),[couriers,setCouriers]=useState<Row[]>([]),[error,setError]=useState('');useEffect(()=>{api<Row>(`/deliveries/${id}`).then(setData).catch(e=>setError(e.message));loadChoiceItems('/tenant/users?role=courier&status=active').then(setCouriers).catch(e=>setError((e as Error).message))},[id]);async function assign(e:FormEvent<HTMLFormElement>){e.preventDefault();try{await api(`/deliveries/${id}/assignment`,{method:'POST',body:JSON.stringify({courierMembershipId:String(new FormData(e.currentTarget).get('courier'))})});setData(await api<Row>(`/deliveries/${id}`));refresh()}catch(e){setError((e as Error).message)}}async function edit(e:FormEvent<HTMLFormElement>){e.preventDefault();try{const form=new FormData(e.currentTarget);const merchandiseDescription=String(form.get('merchandiseDescription')??'').trim();const instructions=String(form.get('instructions')).trim();const payload:Row={instructions:instructions||null};if(merchandiseDescription)payload.merchandiseDescription=merchandiseDescription;await api(`/deliveries/${id}`,{method:'PATCH',body:JSON.stringify(payload)});setData(await api<Row>(`/deliveries/${id}`));refresh();setError('')}catch(e){setError((e as Error).message)}}async function cancel(){if(!window.confirm('Cancelar esta entrega?'))return;try{await api(`/deliveries/${id}/cancel`,{method:'POST',body:'{}'});setData(await api<Row>(`/deliveries/${id}`));refresh()}catch(e){setError((e as Error).message)}}return <div className="detail"><button onClick={onClose}>← Voltar</button>{error&&<div className="alert">{error}</div>}{data&&<><h2>Entrega {id.slice(0,8)}</h2><p><b>Status:</b> {deliveryStatuses[String(data.status)]??String(data.status)}</p>{data.is_claimable===true&&<p className="notice">Disponível para retirada pelo primeiro entregador que aceitar.</p>}<p><b>Volumes:</b></p>{Array.isArray(data.items)&&data.items.length>0?<div className="delivery-item-list">{(data.items as Row[]).map(item=><div key={String(item.id)}><VolumeIcon iconKey={item.icon_key}/><b>{Number(item.quantity)}×</b> {String(item.name)}</div>)}</div>:<p>{String(data.merchandise_description)}</p>}<p><b>Destino:</b> {destinationText(data.destination_snapshot)}</p><p><b>Instruções:</b> {String(data.instructions??'—')}</p>{!['completed','cancelled'].includes(String(data.status))&&<><form onSubmit={edit}>{(!Array.isArray(data.items)||!data.items.length)&&<label>Descrição dos itens<input name="merchandiseDescription" required defaultValue={String(data.merchandise_description??'')}/></label>}<label>Instruções<input name="instructions" defaultValue={String(data.instructions??'')}/></label><button>Salvar entrega</button></form><form onSubmit={assign}><label>Entregador<select name="courier" required><option value="">Selecione</option>{couriers.map(c=><option key={String(c.membership_id)} value={String(c.membership_id)}>{String(c.full_name??c.email)}</option>)}</select></label><button disabled={!couriers.length}>Atribuir ou reatribuir</button></form><button className="danger" onClick={cancel}>Cancelar entrega</button></>}<LiveRoute routeId={typeof data.route_id==='string'?data.route_id:''}/><h3>Histórico</h3>{Array.isArray(data.events)?data.events.map((event:Row)=><div className="event" key={String(event.id)}><b>{eventKinds[String(event.kind)]??String(event.kind)}</b><span>{eventDate(event.occurred_at??event.recorded_at)}</span><p>{String(event.note??'')}</p></div>):null}<h3>Fotos</h3>{Array.isArray(data.photos)?data.photos.map((photo:Row)=><Photo key={String(photo.id)} id={String(photo.id)}/>):null}</>}</div>}
function LiveRoute({routeId}:{routeId:string}){
 const [data,setData]=useState<Row|null>(null),[error,setError]=useState('');
 useEffect(()=>{if(!routeId)return;let active=true;const load=()=>api<Row>(`/tenant/routes/${routeId}/live`).then(value=>{if(active){setData(value);setError('')}}).catch(e=>{if(active)setError((e as Error).message)});void load();const timer=setInterval(load,10_000);return()=>{active=false;clearInterval(timer)}},[routeId]);
 if(!routeId)return null;const points=(data?.points as Row[]|undefined)??[];const last=points.at(-1);const age=last?Date.now()-new Date(String(last.received_at)).getTime():Infinity;const stops=(data?.stops as Row[]|undefined)??[];
 const destination=stops.map(stop=>stop.destination_snapshot as Row).find(value=>value.reference_latitude!=null&&value.reference_longitude!=null);
 const project=(lat:number,lon:number)=>({x:lon,y:Math.log(Math.tan(Math.PI/4+Math.max(-85,Math.min(85,lat))*Math.PI/360))});
 const coords=points.map(point=>project(Number(point.latitude),Number(point.longitude)));const dest=destination?project(Number(destination.reference_latitude),Number(destination.reference_longitude)):null;const current=last?project(Number(last.latitude),Number(last.longitude)):null;const all=[...coords,...(dest?[dest]:[])];
 const minX=Math.min(...all.map(p=>p.x),-0.00001),maxX=Math.max(...all.map(p=>p.x),0.00001),minY=Math.min(...all.map(p=>p.y),-0.00001),maxY=Math.max(...all.map(p=>p.y),0.00001);const padX=(maxX-minX)*.12||.0001,padY=(maxY-minY)*.12||.0001;const mercLat=(y:number)=>(2*Math.atan(Math.exp(y))-Math.PI/2)*180/Math.PI;const box=`${minX-padX},${mercLat(maxY+padY)},${maxX+padX},${mercLat(minY-padY)}`;const xy=(p:{x:number;y:number})=>`${((p.x-minX+padX)/(maxX-minX+2*padX))*1000},${1000-((p.y-minY+padY)/(maxY-minY+2*padY))*560}`;
 const distance=last&&destination?(()=>{const rad=(n:number)=>n*Math.PI/180;const dLat=rad(Number(destination.reference_latitude)-Number(last.latitude)),dLon=rad(Number(destination.reference_longitude)-Number(last.longitude));const h=Math.sin(dLat/2)**2+Math.cos(rad(Number(last.latitude)))*Math.cos(rad(Number(destination.reference_latitude)))*Math.sin(dLon/2)**2;return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h))})():null;
 const center=current??dest;const marker=center?`&marker=${Number(last?.latitude??destination?.reference_latitude)}%2C${Number(last?.longitude??destination?.reference_longitude)}`:'';
 return <section className="live-route"><h3>Acompanhamento da rota</h3>{error&&<div className="alert">{error}</div>}{last&&<p className={age>90_000?'status-overdue':'notice'}>{age>90_000?'Posição desatualizada':'Última posição'} · {eventDate(last.received_at)}</p>}{center&&<div style={{position:'relative',height:280,overflow:'hidden',borderRadius:14}}><iframe title="Mapa da rota" src={`https://www.openstreetmap.org/export/embed.html?bbox=${box.replaceAll(',','%2C')}&layer=mapnik${marker}`} loading="lazy" referrerPolicy="no-referrer" style={{width:'100%',height:'100%',border:0,pointerEvents:'none'}}/><svg viewBox="0 0 1000 560" preserveAspectRatio="none" style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none'}}>{coords.length>1&&<polyline points={coords.map(xy).join(' ')} fill="none" stroke="#0F4C5C" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round"/>}{current&&<circle cx={xy(current).split(',')[0]} cy={xy(current).split(',')[1]} r="18" fill="#0F4C5C" stroke="white" strokeWidth="8"/>}{dest&&<circle cx={xy(dest).split(',')[0]} cy={xy(dest).split(',')[1]} r="18" fill="#D8AE45" stroke="white" strokeWidth="8"/>}</svg></div>}{!center&&<p>Aguardando a primeira posição GPS.</p>}<p>{points.length} posições · {stops.length} paradas{distance!==null?` · ${distance<1?`${Math.round(distance*1000)} m`:`${distance.toFixed(1)} km`} aproximados até o destino`:''}</p><small>Distância em linha reta; o mapa mostra a trilha GPS recebida.</small></section>
}
function Photo({id}:{id:string}){const[url,setUrl]=useState(''),[error,setError]=useState('');useEffect(()=>{const controller=new AbortController();let objectUrl='';setUrl('');setError('');fetch(`/v1/delivery-photos/${id}`,{credentials:'include',signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error('Não foi possível carregar a foto');return response.blob()}).then(blob=>{if(!controller.signal.aborted){objectUrl=URL.createObjectURL(blob);setUrl(objectUrl)}}).catch(e=>{if(!controller.signal.aborted)setError((e as Error).message)});return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl)}},[id]);return url?<img className="photo" src={url} alt="Comprovante da entrega"/>:error?<div className="alert">{error}</div>:<span>Carregando foto…</span>}

function inviteLink(token:string){return new URL('/?invite='+encodeURIComponent(token),location.origin).toString()}
type Editable={path:string;fields:{key:string;column:string;label:string;type?:string}[];status?:{path:string;values:string[];column:string}};
const editable:Record<string,Editable>={
 customers:{path:'/tenant/customers',fields:[{key:'name',column:'name',label:'Nome'},{key:'phone',column:'phone',label:'Telefone'},{key:'email',column:'email',label:'E-mail'},{key:'notes',column:'notes',label:'Observações'}]},
 addresses:{path:'/tenant/addresses',fields:[{key:'label',column:'label',label:'Identificação'},{key:'street',column:'street',label:'Rua'},{key:'number',column:'number',label:'Número'},{key:'complement',column:'complement',label:'Complemento'},{key:'neighborhood',column:'neighborhood',label:'Bairro'},{key:'city',column:'city',label:'Cidade'},{key:'state',column:'state',label:'UF'},{key:'postalCode',column:'postal_code',label:'CEP'}]},
 users:{path:'/tenant/users',fields:[{key:'fullName',column:'full_name',label:'Nome'}],status:{path:'status',values:['active','inactive'],column:'status'}},
 tenants:{path:'/platform/tenants',fields:[{key:'name',column:'name',label:'Nome'},{key:'legalName',column:'legal_name',label:'Razão social'},{key:'cnpj',column:'cnpj',label:'CNPJ'},{key:'contactEmail',column:'contact_email',label:'E-mail'}],status:{path:'status',values:['active','suspended','closed'],column:'status'}},
 plans:{path:'/platform/plans',fields:[{key:'name',column:'name',label:'Nome'},{key:'maxCouriers',column:'max_couriers',label:'Entregadores',type:'number'},{key:'maxUsers',column:'max_users',label:'Usuários',type:'number'},{key:'maxMonthlyDeliveries',column:'max_monthly_deliveries',label:'Entregas por mês',type:'number'},{key:'maxStorageBytes',column:'max_storage_bytes',label:'Armazenamento',type:'number'}]},
 subscriptions:{path:'/platform/subscriptions',fields:[],status:{path:'status',values:['active','suspended','ended'],column:'status'}}
};
export function ManageRecord({section,row,onClose,refresh}:{section:string;row:Row;onClose:()=>void;refresh:()=>void}){const config=editable[section];const[error,setError]=useState(''),[message,setMessage]=useState('');if(!config)return null;const id=String(row.membership_id??row.id);async function save(e:FormEvent<HTMLFormElement>){e.preventDefault();setError('');const form=new FormData(e.currentTarget);const body:Row={};for(const field of config.fields){const value=String(form.get(field.key)??'');if(value!==String(row[field.column]??''))body[field.key]=value===''?null:field.type==='number'?Number(value):value}if(!Object.keys(body).length)return;try{if(section==='users')await api(`${config.path}/${id}/profile`,{method:'PATCH',body:JSON.stringify({fullName:body.fullName})});else await api(`${config.path}/${id}`,{method:'PATCH',body:JSON.stringify(body)});setMessage('Alterações salvas.');refresh()}catch(e){setError((e as Error).message)}}async function status(value:string){try{await api(`${config.path}/${id}/${config.status!.path}`,{method:'PATCH',body:JSON.stringify({status:value})});setMessage('Situação atualizada.');refresh()}catch(e){setError((e as Error).message)}}async function resetPassword(){try{const result=await api<Row>(`${config.path}/${String(row.user_id)}/password-reset`,{method:'POST'});setMessage(`Link de redefinição: ${inviteLink(String(result.token))}`)}catch(e){setError((e as Error).message)}}async function archive(){try{await api(`${config.path}/${id}`,{method:'PATCH',body:JSON.stringify({archived:true})});setMessage('Registro arquivado.');refresh()}catch(e){setError((e as Error).message)}}return <section className="detail"><button onClick={onClose}>← Voltar</button><h2>{String(row.name??row.full_name??row.email??row.id)}</h2>{config.fields.length>0&&<form onSubmit={save}><div className="fields">{config.fields.map(field=><label key={field.key}>{field.label}<input name={field.key} type={field.type??'text'} defaultValue={String(row[field.column]??'')}/></label>)}</div><button>Salvar alterações</button></form>}{section==='customers'&&<CustomerAddresses key={id} customerId={id}/>} {section==='addresses'&&<><AddressFacade key={id} id={id}/><AddressLocation id={id} row={row} refresh={refresh}/></>}{config.status&&<div className="status-actions"><span>Situação: {String(row[config.status.column])}</span>{config.status.values.map(value=><button key={value} onClick={()=>status(value)} disabled={row[config.status!.column]===value}>{value}</button>)}</div>}{section==='users'&&<button onClick={resetPassword}>Gerar link de redefinição de senha</button>}{['customers','addresses','delivery-items'].includes(section)&&<button className="danger" onClick={archive}>Arquivar</button>}{error&&<div className="alert">{error}</div>}{message&&<div className="notice">{message}</div>}</section>}

function CustomerAddresses({customerId}:{customerId:string}) {
  const [rows,setRows]=useState<Row[]|null>(null);
  const [revision,setRevision]=useState(0);
  const [draft,setDraft]=useState<Row|null>(null);
  const [busy,setBusy]=useState(false);
  const [loadError,setLoadError]=useState('');
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const fields=editable.addresses.fields;
  useEffect(()=>{
    let current=true;
    setLoadError('');
    loadChoiceItems('/tenant/addresses?customerId='+encodeURIComponent(customerId))
      .then(items=>{if(current)setRows(items);})
      .catch(e=>{if(current)setLoadError(e.message);});
    return ()=>{current=false;};
  },[customerId,revision]);

  function open(address:Row|null) {
    setDraft(address);
    setError('');
    setMessage('');
  }
  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(!draft || busy)return;
    const data=new FormData(event.currentTarget);
    const body:Row=draft.id ? {} : {customerId};
    for(const field of fields) {
      let value=String(data.get(field.key)??'').trim();
      if(field.key==='state')value=value.toUpperCase();
      if(value!==String(draft[field.column]??''))body[field.key]=value||null;
    }
    setBusy(true);
    setError('');
    try {
      if(Object.keys(body).length) {
        const url=draft.id ? '/tenant/addresses/'+draft.id : '/tenant/addresses';
        const saved=await api<Row>(url,{method:draft.id?'PATCH':'POST',body:JSON.stringify(body)});
        setRows(current=>[saved,...(current??[]).filter(row=>row.id!==saved.id)]);
        setRevision(r=>r+1);
      }
      setMessage(draft.id?'Endereço atualizado.':'Endereço cadastrado.');
      setDraft(null);
    } catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  return <section className="customer-addresses">
    <div className="entry-heading"><h3>Endereços do cliente</h3>
      {!draft && <button type="button" onClick={()=>open({})}>Novo endereço</button>}</div>
    {message && <p role="status">{message}</p>}
    {loadError && <div role="alert">{loadError} <button type="button" onClick={()=>setRevision(r=>r+1)}>Tentar novamente</button></div>}
    {draft ? <div key={String(draft.id??'new')}>
      <h4>{draft.id?'Editar endereço':'Novo endereço'}</h4>
      <form onSubmit={save}><AddressLookup/><div className="fields">{fields.map(field=>field.key==='street'
        ? <StreetField key={field.key} name="street" initialStreet={String(draft.street??'')}/>
        : <label key={field.key}>{field.label}<input name={field.key} defaultValue={String(draft[field.column]??'')}
          required={field.key==='city'||field.key==='state'} pattern={field.key==='state'?'[A-Za-z]{2}':undefined}
          maxLength={field.key==='state'?2:undefined}/></label>)}</div>
        {error && <p role="alert">{error}</p>}
        <div className="status-actions"><button disabled={busy}>{busy?'Salvando…':'Salvar endereço'}</button>
          <button type="button" className="secondary-action" disabled={busy} onClick={()=>open(null)}>Cancelar</button></div>
      </form>
      {!!draft.id && <><AddressFacade id={String(draft.id)}/><AddressLocation id={String(draft.id)} row={draft} refresh={()=>setRevision(r=>r+1)}/></>}
    </div> : <>
      {!rows && !loadError && <p role="status">Carregando endereços…</p>}
      {rows?.length===0 && <p>Nenhum endereço cadastrado para este cliente.</p>}
      {rows?.map(row=><div className="customer-address" key={String(row.id)}><div>
        <strong>{String(row.label||row.street)}{row.archived_at?' · Arquivado':''}</strong>
        <div>{[row.street,row.number,row.complement].filter(Boolean).join(', ')}</div>
        <div>{[row.neighborhood,[row.city,row.state].filter(Boolean).join(' – '),row.postal_code].filter(Boolean).join(' · ')}</div>
      </div><button type="button" className="secondary-action" aria-label={'Editar endereço '+String(row.label||row.street)} onClick={()=>open(row)}>Editar</button></div>)}
    </>}
  </section>;
}

function AddressFacade({id}:{id:string}) {
  const path='/tenant/addresses/'+id+'/facade';
  const [photo,setPhoto]=useState<{image:string|null;requested:boolean}|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [reload,setReload]=useState(0);
  useEffect(()=>{
    let current=true;
    api<{image:string|null;requested:boolean}>(path).then(value=>{if(current){setPhoto(value);setError('');}})
      .catch(e=>{if(current)setError(e.message);});
    return ()=>{current=false;};
  },[path,reload]);
  async function change(action:'request'|'remove') {
    if (action==='remove' && !window.confirm('Apagar a foto da casa e solicitar outra na próxima entrega?')) return;
    setBusy(true);
    try {
      await api(path,{method:'PATCH',body:JSON.stringify({action})});
      setPhoto({image:action==='remove'?null:photo?.image??null,requested:true});
      setError('');
    } catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  return <section><h3>Foto da casa</h3>
    {photo?.image && <img src={photo.image} alt="Fachada do endereço de entrega" style={{maxWidth:'100%',maxHeight:280}}/>}
    {photo && <><p>{photo.requested?'Nova foto solicitada ao entregador.':photo.image?'Foto disponível para os entregadores.':'Este endereço ainda não tem foto.'}</p>
      <button type="button" disabled={busy||photo.requested} onClick={()=>change('request')}>Solicitar foto da casa</button>
      {photo.image && <button type="button" disabled={busy} onClick={()=>change('remove')}>Apagar foto</button>}</>}
    {error && <p role="alert">{error} <button type="button" onClick={()=>setReload(n=>n+1)}>Tentar novamente</button></p>}
  </section>;
}

function AddressLocation({id,row,refresh}:{id:string;row:Row;refresh:()=>void}){const[error,setError]=useState(''),[saved,setSaved]=useState(false);async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget);const latitude=Number(form.get('latitude')),longitude=Number(form.get('longitude'));try{await api(`/tenant/addresses/${id}/location`,{method:'PATCH',body:JSON.stringify({latitude,longitude})});setSaved(true);setError('');refresh()}catch(e){setError((e as Error).message)}}return <div className="location-editor"><h3>Localização do mapa</h3><p>Informe as coordenadas de referência para exibir a prévia no app do entregador.</p><form onSubmit={submit}><label>Latitude<input name="latitude" type="number" step="0.000001" min="-90" max="90" required defaultValue={String(row.reference_latitude??'')}/></label><label>Longitude<input name="longitude" type="number" step="0.000001" min="-180" max="180" required defaultValue={String(row.reference_longitude??'')}/></label><button>Salvar coordenadas</button></form>{saved&&<div className="notice">Localização atualizada. A prévia aparecerá após sincronizar o app.</div>}{error&&<div className="alert">{error}</div>}</div>}

export function TenantSettings({data,refresh}:{data:Row;refresh:()=>void}){const[error,setError]=useState(''),[saved,setSaved]=useState(false);async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();try{const contactEmail=String(new FormData(e.currentTarget).get('contactEmail')).trim()||null;await api('/tenant/settings',{method:'PATCH',body:JSON.stringify({contactEmail})});setSaved(true);setError('');refresh()}catch(e){setError((e as Error).message)}}return <section className="detail"><h2>{String(data.name??'Empresa')}</h2><p>Situação: {String(data.status??'—')}</p><form onSubmit={submit}><label>E-mail de contato<input name="contactEmail" type="email" defaultValue={String(data.contact_email??'')}/></label><button>Salvar contato</button></form>{saved&&<div className="notice">Contato atualizado.</div>}{error&&<div className="alert">{error}</div>}</section>}

function LiveOperationMap() {
  const [data,setData]=useState<Row|null>(()=>latestDashboardData as Row|null);
  useEffect(()=>{const receive=(event:Event)=>setData((event as CustomEvent<Row>).detail);window.addEventListener('entregaja:dashboard-data',receive);return()=>window.removeEventListener('entregaja:dashboard-data',receive)},[]);
  useEffect(()=>{const stream=new EventSource('/v1/tenant/live-locations/stream');const receive=(event:MessageEvent)=>{try{const liveCouriers=JSON.parse(event.data) as Row[];setData(previous=>({... (previous ?? {}),liveCouriers}))}catch{}};stream.addEventListener('locations',receive);return()=>{stream.removeEventListener('locations',receive);stream.close()}},[]);
  const couriers=Array.isArray(data?.liveCouriers)?data.liveCouriers as Row[]:[];
  const worker = data?.worker as Row | undefined;
  const noticeLabels: Record<string,string> = {
    active: 'Envio de avisos ativo', stopped: 'O envio de avisos pode estar atrasado',
    error: 'Houve uma falha ao enviar avisos', no_credential: 'Avisos no celular desativados',
    no_heartbeat: 'Aguardando confirmação do serviço de avisos',
  };
  const pending = Number(worker?.pending ?? 0);
  return <section className="live-operation">
    <h2>Operação ao vivo</h2>
    <p>{couriers.length === 1 ? '1 entregador compartilhando a localização' :
      couriers.length ? `${couriers.length} entregadores compartilhando a localização` : 'Nenhum entregador compartilhando a localização agora'}</p>
    <CourierMap couriers={couriers}/>
    {worker && <p>{noticeLabels[String(worker.status)]}{pending > 0 && ` · ${pending} ${pending === 1 ? 'aviso aguardando envio' : 'avisos aguardando envio'}`}</p>}
  </section>;
}

function Heatmap() { const [points,setPoints]=useState<Row[]>([]); const [error,setError]=useState(''); useEffect(()=>{api<Row[]>('/tenant/reports/heatmap').then(setPoints).catch(()=>setError('Não foi possível carregar o mapa de concentração.'))},[]); const valid=points.map(point=>({lat:Number(point.latitude),lon:Number(point.longitude),weight:Number(point.weight??1)})).filter(point=>Number.isFinite(point.lat)&&Number.isFinite(point.lon)); const minLat=Math.min(...valid.map(point=>point.lat),-3.78),maxLat=Math.max(...valid.map(point=>point.lat),-3.72),minLon=Math.min(...valid.map(point=>point.lon),-38.56),maxLon=Math.max(...valid.map(point=>point.lon),-38.50); const left=(lon:number)=>`${((lon-minLon)/(maxLon-minLon||1))*100}%`; const top=(lat:number)=>`${100-((lat-minLat)/(maxLat-minLat||1))*100}%`; return <section className="heatmap-card"><div className="section-heading"><div><h2>Concentração de entregas</h2><p>Entregas concluídas por localização</p></div><span className="live-indicator">Até 1.000 pontos</span></div>{error&&<div className="alert">{error}</div>}{valid.length?<div className="heatmap-map" role="img" aria-label="Mapa de concentração das entregas concluídas"><iframe title="Mapa base da concentração de entregas" src={`https://www.openstreetmap.org/export/embed.html?bbox=${minLon}%2C${minLat}%2C${maxLon}%2C${maxLat}&layer=mapnik`} loading="lazy" referrerPolicy="no-referrer"/>{valid.map((point,index)=><span key={`${point.lat}-${point.lon}-${index}`} className="heatmap-point" style={{left:left(point.lon),top:top(point.lat),opacity:Math.min(.9,.25+point.weight/10),transform:`translate(-50%,-50%) scale(${Math.min(2.5,1+point.weight/5)})`}} title={`${point.weight} entregas`}/>)}</div>:<p className="empty-hint">Ainda não há coordenadas suficientes para montar o mapa.</p>}</section>; }

function GamificationPanel({refresh}:{refresh:()=>void}) { const [data,setData]=useState<Row|null>(null); const [error,setError]=useState(''); const [busy,setBusy]=useState(false); async function load(){setBusy(true);setError('');try{setData(await api<Row>('/tenant/gamification'));}catch{setError('Não foi possível carregar a gamificação agora.');}finally{setBusy(false)}} useEffect(()=>{void load()},[]); return data ? <GamificationSettings data={data} refresh={()=>{refresh();void load()}}/> : error ? <div className="empty"><p>{error}</p><button className="retry-button" onClick={()=>void load()} disabled={busy}>{busy?'Tentando…':'Tentar novamente'}</button></div> : <div className="empty">Carregando configurações…</div>; }

export function GamificationSettings({data,refresh}:{data:Row;refresh:()=>void}) {
  const settings=(data.settings??{}) as Row;
  const badges=Array.isArray(data.badges)?data.badges as Row[]:[];
  const reasons=Array.isArray(data.reasons)?data.reasons as Row[]:[];
  const challenges=Array.isArray(data.challenges)?data.challenges as Row[]:[];
  const overview=(data.overview??{}) as Row;
  const summary=(overview.summary??{}) as Row;
  const leaderboard=Array.isArray(overview.leaderboard)?overview.leaderboard as Row[]:[];
  const badgeProgress=Array.isArray(overview.badgeProgress)?overview.badgeProgress as Row[]:[];
  const activeChallenge=overview.activeChallenge as Row|null|undefined;
  const [goal,setGoal]=useState(String(settings.daily_goal??10));
  const [celebration,setCelebration]=useState(Boolean(settings.celebration_enabled??true));
  const [busy,setBusy]=useState(false); const [message,setMessage]=useState(''); const [error,setError]=useState('');
  const [badgeName,setBadgeName]=useState(''); const [badgeDescription,setBadgeDescription]=useState(''); const [badgeTarget,setBadgeTarget]=useState('5');
  const [challengeName,setChallengeName]=useState(''); const [challengeTarget,setChallengeTarget]=useState('10'); const [challengeBonus,setChallengeBonus]=useState('0'); const [challengeStart,setChallengeStart]=useState(new Date().toISOString().slice(0,10)); const [challengeEnd,setChallengeEnd]=useState(new Date(Date.now()+7*86400000).toISOString().slice(0,10));
  function money(cents:unknown){return (Number(cents??0)/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}
  function date(value:unknown){if(!value)return '—';const parsed=new Date(String(value));return Number.isNaN(parsed.getTime())?String(value):parsed.toLocaleDateString('pt-BR',{timeZone:'America/Fortaleza'})}
  function percent(value:unknown,target:unknown){return Math.min(100,Math.round(Number(value??0)/Math.max(1,Number(target??1))*100))}
  async function save(event:FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');setMessage('');try{await api('/tenant/gamification',{method:'PATCH',body:JSON.stringify({dailyGoal:Number(goal),celebrationEnabled:celebration})});setMessage('Configurações salvas.');refresh()}catch{setError('Não foi possível salvar a configuração.')}finally{setBusy(false)}}
  async function addBadge(event:FormEvent<HTMLFormElement>){event.preventDefault();try{await api('/tenant/gamification/badges',{method:'POST',body:JSON.stringify({name:badgeName,description:badgeDescription,target:Number(badgeTarget)})});setBadgeName('');setBadgeDescription('');setMessage('Medalha adicionada.');refresh()}catch{setError('Não foi possível adicionar a medalha.')}}
  async function addChallenge(event:FormEvent<HTMLFormElement>){event.preventDefault();try{await api('/tenant/gamification/challenges',{method:'POST',body:JSON.stringify({name:challengeName,target:Number(challengeTarget),bonusCents:Number(challengeBonus),startsAt:challengeStart,endsAt:challengeEnd})});setChallengeName('');setMessage('Desafio adicionado.');refresh()}catch{setError('Não foi possível adicionar o desafio.')}}
  async function toggleBadge(badge:Row){try{await api(`/tenant/gamification/badges/${String(badge.id)}`,{method:'PATCH',body:JSON.stringify({active:badge.active===false})});setMessage(`Medalha ${badge.active===false?'ativada':'desativada'}.`);refresh()}catch{setError('Não foi possível atualizar a medalha.')}}
  async function toggleChallenge(challenge:Row){try{await api(`/tenant/gamification/challenges/${String(challenge.id)}`,{method:'PATCH',body:JSON.stringify({active:challenge.active===false})});setMessage(`Desafio ${challenge.active===false?'ativado':'desativado'}.`);refresh()}catch{setError('Não foi possível atualizar o desafio.')}}
  async function toggleReason(reason:Row){try{await api(`/tenant/gamification/problem-reasons/${String(reason.id)}`,{method:'PATCH',body:JSON.stringify({active:reason.active===false})});setMessage(`Motivo ${reason.active===false?'ativado':'desativado'}.`);refresh()}catch{setError('Não foi possível atualizar o motivo.')}}
  return <section className="gamification-page">
    <div className="gamification-intro"><div><h2>Performance da equipe</h2><p>Acompanhe o engajamento e configure os incentivos dos entregadores.</p></div><span className="live-indicator">Atualizado agora</span></div>
    <div className="gamification-stats">
      <div className="gamification-stat"><Trophy/><span>Hoje</span><strong>{String(summary.today??0)}</strong><small>entregas concluídas</small></div>
      <div className="gamification-stat"><Target/><span>Esta semana</span><strong>{String(summary.week??0)}</strong><small>entregas concluídas</small></div>
      <div className="gamification-stat"><Medal/><span>Este mês</span><strong>{String(summary.month??0)}</strong><small>entregas concluídas</small></div>
      <div className="gamification-stat"><Users/><span>Equipe ativa</span><strong>{String(summary.activeCouriers??0)}</strong><small>entregadores</small></div>
    </div>
    <div className="gamification-columns">
      <section className="gamification-card"><div className="section-heading"><div><h3>Ranking da equipe</h3><p>Produção por entregador</p></div><Trophy size={20}/></div>{leaderboard.length?<div className="ranking-list">{leaderboard.map((row,index)=><div className="ranking-row" key={String(row.membershipId)}><strong className="ranking-position">{index+1}º</strong><span className="ranking-name">{String(row.name)}<small>{Number(row.weekCompleted??0)} esta semana · {Number(row.monthCompleted??0)} no mês</small></span><b>{Number(row.weekCompleted??0)}<small> entregas</small></b></div>)}</div>:<p className="empty-hint">Ainda não há entregas concluídas para formar o ranking.</p>}</section>
      <section className="gamification-card"><div className="section-heading"><div><h3>Desafio atual</h3><p>Meta coletiva do período</p></div><Target size={20}/></div>{activeChallenge?<div className="challenge-overview"><div><strong>{String(activeChallenge.name)}</strong><span>{String(activeChallenge.description||'Conclua entregas para liberar o bônus.')}</span></div><div className="progress-track"><i style={{width:`${percent(activeChallenge.completed,activeChallenge.target)}%`}}/></div><div className="progress-label"><b>{Number(activeChallenge.completed??0)} / {Number(activeChallenge.target??0)} entregas</b><span>{money(activeChallenge.bonusCents)} · até {date(activeChallenge.endsAt)}</span></div></div>:<p className="empty-hint">Nenhum desafio ativo no momento.</p>}</section>
    </div>
    <section className="gamification-card"><div className="section-heading"><div><h3>Medalhas da equipe</h3><p>Progresso médio e entregadores que já desbloquearam cada conquista.</p></div><Medal size={20}/></div>{badgeProgress.length?<div className="badge-progress-grid">{badgeProgress.map(badge=><div className="badge-progress" key={String(badge.id)}><div className="badge-progress-title"><span><Medal size={18}/>{String(badge.name)}</span><b>{Number(badge.unlockedCouriers??0)} / {Number(badge.totalCouriers??0)}</b></div><div className="progress-track"><i style={{width:`${percent(badge.averageProgress,badge.target)}%`}}/></div><small>{Number(badge.averageProgress??0)} de {Number(badge.target??0)} entregas em média</small></div>)}</div>:<p className="empty-hint">Cadastre uma medalha para acompanhar o progresso da equipe.</p>}</section>
    <section className="detail gamification-editor"><div className="section-heading"><div><h2>Configurações</h2><p>Defina o que aparece para os entregadores no aplicativo.</p></div></div><form onSubmit={save}><div className="fields"><label>Meta diária<input type="number" min="1" max="500" value={goal} onChange={event=>setGoal(event.target.value)}/></label><label className="toggle-field"><span>Celebração ao concluir</span><input type="checkbox" checked={celebration} onChange={event=>setCelebration(event.target.checked)}/></label></div><button disabled={busy}>{busy?'Salvando…':'Salvar configurações'}</button></form>{message&&<div className="notice">{message}</div>}{error&&<div className="alert">{error}</div>}<div className="gamification-preview"><h3>Prévia no app</h3><div className="preview-card"><strong>0 / {goal} entregas</strong><span>Meta de hoje · sequência de dias</span></div></div>
      <h3>Medalhas configuráveis</h3><form className="badge-form" onSubmit={addBadge}><label>Nome<input required value={badgeName} onChange={event=>setBadgeName(event.target.value)}/></label><label>Descrição<input required value={badgeDescription} onChange={event=>setBadgeDescription(event.target.value)}/></label><label>Meta<input required type="number" min="1" value={badgeTarget} onChange={event=>setBadgeTarget(event.target.value)}/></label><button>Adicionar medalha</button></form>{badges.length?<div className="config-list">{badges.map(badge=><div key={String(badge.id)}><b>{String(badge.name)}</b><span>{String(badge.description)} · meta {String(badge.target)} · {badge.active===false?'Inativa':'Ativa'}</span><button type="button" className="secondary" onClick={()=>toggleBadge(badge)}>{badge.active===false?'Ativar':'Desativar'}</button></div>)}</div>:<p>Nenhuma medalha configurada ainda.</p>}
      <h3>Desafios com bônus</h3><form className="badge-form" onSubmit={addChallenge}><label>Nome<input required value={challengeName} onChange={event=>setChallengeName(event.target.value)}/></label><label>Entregas alvo<input required type="number" min="1" value={challengeTarget} onChange={event=>setChallengeTarget(event.target.value)}/></label><label>Bônus (centavos)<input type="number" min="0" value={challengeBonus} onChange={event=>setChallengeBonus(event.target.value)}/></label><label>Início<input required type="date" value={challengeStart} onChange={event=>setChallengeStart(event.target.value)}/></label><label>Fim<input required type="date" value={challengeEnd} onChange={event=>setChallengeEnd(event.target.value)}/></label><button>Adicionar desafio</button></form>{challenges.length?<div className="config-list">{challenges.map(challenge=><div key={String(challenge.id)}><b>{String(challenge.name)}</b><span>{String(challenge.target)} entregas · bônus {money(challenge.bonus_cents)} · {date(challenge.starts_at)} a {date(challenge.ends_at)} · {challenge.active===false?'Inativo':'Ativo'}</span><button type="button" className="secondary" onClick={()=>toggleChallenge(challenge)}>{challenge.active===false?'Ativar':'Desativar'}</button></div>)}</div>:<p>Nenhum desafio configurado ainda.</p>}
      <h3>Motivos de problema</h3><div className="config-list">{reasons.map(reason=><div key={String(reason.id)}><b>{String(reason.label)}</b><span>{reason.active===false?'Inativo':'Ativo'}</span><button type="button" className="secondary" onClick={()=>toggleReason(reason)}>{reason.active===false?'Ativar':'Desativar'}</button></div>)}</div>
    </section>
  </section>}
import { AddressLookup, StreetField } from './AddressLookup';
