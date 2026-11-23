import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export function ImportedStreets({query}: {query:string}) {
  const [streets,setStreets] = useState<string[]>([]);
  const [limit,setLimit] = useState(8);
  const [status,setStatus] = useState('Carregando ruas…');
  const [revision,setRevision] = useState(0);
  useEffect(() => {
    const reload = () => setRevision(value => value + 1);
    window.addEventListener('entregaja:streets-imported',reload);
    return () => window.removeEventListener('entregaja:streets-imported',reload);
  },[]);
  useEffect(() => {
    let current = true;
    setLimit(8);
    setStreets([]);
    setStatus('Carregando ruas…');
    const params = new URLSearchParams({category:'street', search:query, limit:'200'});
    api<{items:{name:string}[]}>('/tenant/localities?' + params).then(({items}) => {
      if (!current) return;
      setStreets(items.map(item => item.name));
      setStatus(items.length ? '' : query ? 'Nenhuma rua importada corresponde à busca.' : 'Nenhuma rua importada.');
    }).catch(() => {if (current) setStatus('Não foi possível carregar as ruas importadas.');});
    return () => {current = false;};
  },[query,revision]);
  return <section className="detail"><h2>Ruas importadas</h2>
    {status && <p role="status">{status}</p>}
    {streets.slice(0,limit).map(street => <div key={street} className="volume-catalog-row">
      <span>{street}</span><button type="button" className="secondary-action" aria-label={`Usar ${street}`}
        onClick={() => window.dispatchEvent(new CustomEvent('entregaja:use-street',{detail:street}))}>Usar rua</button>
    </div>)}
    {streets.length > limit && <button type="button" onClick={() => setLimit(value => value + 20)}>Mostrar mais ruas</button>}
  </section>;
}

export function StreetField({name,initialStreet=''}: {name:string;initialStreet?:string}) {
  const input = useRef<HTMLInputElement>(null);
  const [term,setTerm] = useState('');
  const [suggestions,setSuggestions] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    if (term.trim().length < 2) return;
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({category:'street',search:term.trim(),limit:'12'});
        const result = await api<{items:{name:string}[]}>('/tenant/localities?' + params);
        if (current) setSuggestions(result.items.map(item => item.name));
      } catch { if (current) setSuggestions([]); }
    }, 250);
    return () => {current = false; window.clearTimeout(timer);};
  }, [term]);
  return <div className="street-field">
    <label>Rua<input name={name} ref={input} defaultValue={initialStreet} required autoComplete="off" onChange={e => {
      setTerm(e.target.value); setSuggestions([]);
    }} /></label>
    {suggestions.map(street => <button key={street} className="secondary-action" type="button" onClick={() => {
      if (input.current) input.current.value = street;
      setTerm(''); setSuggestions([]);
    }}>{street}</button>)}
  </div>;
}

type Match = { cep: string; logradouro: string; bairro: string; localidade: string; uf: string };

export function AddressLookup({ prefix = '' }: { prefix?: string }) {
  const [query, setQuery] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLFieldSetElement>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const postal = /^[\d\s-]+$/.test(query.trim());

  function choose(match: Match) {
    const values = { street: match.logradouro, neighborhood: match.bairro, city: match.localidade, state: match.uf, postalCode: match.cep };
    for (const [key, value] of Object.entries(values)) {
      const input = root.current?.form?.elements.namedItem(prefix + key);
      if (input instanceof HTMLInputElement && value) input.value = value;
    }
    setMatches([]);
    setCity(match.localidade);
    setState(match.uf);
    const place = [match.logradouro, match.bairro, match.localidade + ' – ' + match.uf].filter(Boolean).join(', ');
    setMessage(match.logradouro ? place + ' · CEP ' + match.cep : place + ' · CEP ' + match.cep + '. Este CEP identifica o município. Informe a rua e o número abaixo.');
  }

  async function search() {
    setMatches([]);
    const cep = query.replace(/\D/g, '');
    if (postal && cep.length !== 8) return setMessage('Digite os 8 números do CEP.');
    if (!postal && (query.trim().length < 3 || city.trim().length < 3 || !/^[A-Z]{2}$/.test(state))) {
      return setMessage('Informe a UF e pelo menos 3 letras da cidade e da rua.');
    }
    const path = postal ? cep : [state, city.trim(), query.trim()].map(encodeURIComponent).join('/');
    const controller = new AbortController();
    active.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    setBusy(true);
    setMessage('Buscando endereço…');
    try {
      const response = await fetch(`https://viacep.com.br/ws/${path}/json/`, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error();
      const result = await response.json();
      const found: Match[] = (Array.isArray(result) ? result : [result]).filter(item => item?.cep && item.localidade);
      if (postal && found.length === 1) choose(found[0]);
      else {
        setMatches(found);
        setMessage(found.length ? 'Selecione o endereço desejado.' : 'Nenhum endereço encontrado. Revise a busca ou preencha os campos manualmente.');
      }
    } catch {
      setMessage('A consulta está indisponível. Tente novamente ou preencha os campos manualmente.');
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
    }
  }
  function clearResults() { setMatches([]); setMessage(''); }
  return <fieldset ref={root} className="address-lookup" onKeyDown={event => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault(); if (!busy) void search();
    }
  }}>
    <legend>Buscar endereço</legend>
    <label>CEP ou nome da rua<input disabled={busy} value={query} onChange={e => {setQuery(e.target.value); clearResults();}} /></label>
    {!!query.trim() && !postal && <div className="fields">
      <label>Cidade da busca<input disabled={busy} value={city} onChange={e => {setCity(e.target.value); clearResults();}}/></label>
      <label>UF da busca<input disabled={busy} maxLength={2} value={state} onChange={e => {setState(e.target.value.toUpperCase()); clearResults();}}/></label>
    </div>}
    <button type="button" disabled={busy || !query.trim()} onClick={() => void search()}>Buscar endereço</button>
    {message && <p role="status">{message}</p>}
    {matches.map(match => <button type="button" className="secondary-action" key={match.cep} onClick={() => choose(match)}>
      {[match.logradouro, match.bairro, match.localidade, match.uf, match.cep].filter(Boolean).join(' · ')}
    </button>)}
  </fieldset>;
}
