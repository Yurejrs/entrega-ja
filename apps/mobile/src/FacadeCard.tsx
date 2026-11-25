import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
import { cacheFacade, getMeta, enqueue, operations, failedOperations } from './store';
import { flushOperations } from './sync';
import { request } from './api';
import { brand } from './brand';

type Facade = {addressId:string;image:string|null; revision:string; capture:boolean; requested:boolean};

export function FacadeCard({deliveryId}:{deliveryId:string}) {
  const path = '/deliveries/'+deliveryId+'/facade';
  const [photo,setPhoto] = useState<Facade|null>(()=>JSON.parse(getMeta('facade:'+deliveryId)||'null'));
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [attempt,setAttempt] = useState(0);
  useFocusEffect(useCallback(() => {
    let current=true;
    request<Facade>(path).then(value=>{if(current){cacheFacade(deliveryId,JSON.stringify(value));setPhoto(value);setError('');}})
      .catch(()=>{if(current)setError('Não foi possível consultar a foto da casa.');});
    return ()=>{current=false;};
  },[path,attempt]));

  async function capture() {
    if (!photo?.capture || busy) return;
    setBusy(true);
    setError('');
    try {
      const permission=await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {setError('Permita o uso da câmera para fotografar a fachada.');return;}
      const result=await ImagePicker.launchCameraAsync({mediaTypes:['images'],quality:0.75});
      if (result.canceled) return;
      const uri=FileSystem.documentDirectory+'facade-'+randomUUID()+'.jpg';
      await FileSystem.copyAsync({from:result.assets[0].uri,to:uri});
      enqueue(deliveryId,'facade',{photoUri:uri,revision:photo.revision,addressId:photo.addressId});
      await flushOperations();
      setAttempt(value=>value+1);
    } catch (e) {setError((e as Error).message);}
    finally {setBusy(false);}
  }
  const pending=[...operations(),...failedOperations()].find(op=>op.delivery_id===deliveryId&&op.kind==='facade');
  const local=pending?JSON.parse(pending.payload) as {photoUri:string}:null;
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>Foto da casa</Text>
    {photo?.image && <Image source={{uri:photo.image}} accessibilityLabel="Fachada do endereço de entrega" resizeMode="contain" style={styles.image}/>}
    {photo && !photo.image && <Text>{photo.capture?'Fotografe a fachada para ajudar nas próximas entregas.':'Nenhuma foto cadastrada para este endereço.'}</Text>}
    {local && <><Image source={{uri:local.photoUri}} style={styles.image} resizeMode="contain" accessibilityLabel="Foto da casa salva no aparelho"/>
      <Text>{pending?.status==='failed'?'Foto não enviada. Confira a foto atual e revise a operação nas Configurações.':'Foto salva no aparelho, aguardando envio.'}</Text></>}
    {!photo && !error && <Text>Buscando foto…</Text>}
    {photo?.capture && !pending && <Pressable accessibilityRole="button" disabled={busy} onPress={capture} style={styles.button}>
      <Text style={styles.buttonText}>{busy?'Salvando…':photo.requested?'Tirar nova foto da casa':'Fotografar a casa'}</Text>
    </Pressable>}
    {!!error && <><Text accessibilityRole="alert">{error}</Text><Pressable accessibilityRole="button" onPress={()=>setAttempt(a=>a+1)}><Text style={styles.title}>Atualizar foto</Text></Pressable></>}
  </View>;
}
const styles=StyleSheet.create({
  card:{backgroundColor:'white',borderRadius:14,padding:16,gap:10,borderWidth:1,borderColor:brand.border},
  title:{fontSize:17,fontWeight:'600',color:brand.text},image:{width:'100%',height:200},
  button:{backgroundColor:brand.petroleum,borderRadius:10,padding:12,alignItems:'center'},buttonText:{color:'white',fontWeight:'600'},
});
