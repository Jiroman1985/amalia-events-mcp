// Territorio mínimo para deducir la zona (provincia/región) de una fuente. Sin red ni datos externos.
const norm=v=>String(v||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
export const REGIONES_PROVINCIAS={
 'Andalucía':['Almería','Cádiz','Córdoba','Granada','Huelva','Jaén','Málaga','Sevilla'],
 'Aragón':['Huesca','Teruel','Zaragoza'],'Asturias':['Asturias'],'Illes Balears':['Illes Balears'],
 'Canarias':['Las Palmas','Santa Cruz de Tenerife'],'Cantabria':['Cantabria'],
 'Castilla y León':['Ávila','Burgos','León','Palencia','Salamanca','Segovia','Soria','Valladolid','Zamora'],
 'Castilla-La Mancha':['Albacete','Ciudad Real','Cuenca','Guadalajara','Toledo'],
 'Cataluña':['Barcelona','Girona','Lleida','Tarragona'],'Comunitat Valenciana':['Alicante','Castellón','Valencia'],
 'Extremadura':['Badajoz','Cáceres'],'Galicia':['A Coruña','Lugo','Ourense','Pontevedra'],'Madrid':['Madrid'],'Murcia':['Murcia'],'Navarra':['Navarra'],
 'País Vasco':['Álava','Gipuzkoa','Bizkaia'],'La Rioja':['La Rioja'],'Ceuta':['Ceuta'],'Melilla':['Melilla']};
const ALIAS={'la coruna':'A Coruña','coruna':'A Coruña','gerona':'Girona','lerida':'Lleida','alacant':'Alicante','castello':'Castellón','guipuzcoa':'Gipuzkoa','vizcaya':'Bizkaia','araba':'Álava','orense':'Ourense','baleares':'Illes Balears','islas baleares':'Illes Balears','leon':'León','avila':'Ávila','tenerife':'Santa Cruz de Tenerife','gran canaria':'Las Palmas','comunidad de madrid':'Madrid','region de murcia':'Murcia','principado de asturias':'Asturias','rioja':'La Rioja','comunidad valenciana':'Comunitat Valenciana','c valenciana':'Comunitat Valenciana','pais vasco':'País Vasco','euskadi':'País Vasco','catalunya':'Cataluña','cataluna':'Cataluña','andalucia':'Andalucía','aragon':'Aragón','castilla y leon':'Castilla y León','castilla la mancha':'Castilla-La Mancha','canarias':'Canarias','illes balears':'Illes Balears'};
const PROV=new Map(),REG=new Map();
for(const [r,ps] of Object.entries(REGIONES_PROVINCIAS)){REG.set(norm(r),r);for(const p of ps)PROV.set(norm(p),{provincia:p,region:r});}
export const PROVINCIAS=[...PROV.values()].map(v=>v.provincia).sort((a,b)=>a.localeCompare(b,'es'));
export const REGIONES=Object.keys(REGIONES_PROVINCIAS);
/** Canoniza un nombre de provincia o región conocido (con alias). null si no se reconoce. */
export function reconocerZona(v){
 const n=norm(v);if(!n)return null;const a=ALIAS[n]?norm(ALIAS[n]):n;
 if(PROV.has(a))return {tipo:'provincia',...PROV.get(a)};
 if(REG.has(a))return {tipo:'region',provincia:null,region:REG.get(a)};
 return null;
}
export const regionDeProvincia=p=>PROV.get(norm(ALIAS[norm(p)]||p))?.region||null;
/**
 * Deduce la zona de una fuente: 1) si el «municipio» es en realidad una provincia/región conocida; 2) por la provincia/región de otra
 * fuente ya registrada para el mismo municipio. Devuelve {provincia,region,origen} o null (no inventa: sin base, no deduce).
 */
export function deducirZona({municipio,filas=[]}){
 const m=norm(municipio);if(!m)return null;
 const z=reconocerZona(municipio);if(z)return {provincia:z.provincia,region:z.region,origen:'el municipio es una '+z.tipo};
 const hit=filas.map(r=>r.data||r).find(d=>norm(d.municipio)===m&&(d.provincia||d.region));
 if(hit){const p=hit.provincia?reconocerZona(hit.provincia):null;return {provincia:hit.provincia||null,region:hit.region||p?.region||null,origen:'otra fuente registrada en '+municipio};}
 return null;
}
