import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { request } from './api';
import { brand } from './brand';

type Facade = {image:string|null; revision:string; capture:boolean; requested:boolean};

export function FacadeCard({deliveryId}:{deliveryId:string}) {
  const path = '/deliveries/'+deliveryId+'/facade';
  const [photo,setPhoto] = useState<Facade|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [attempt,setAttempt] = useState(0);
  useFocusEffect(useCallback(() => {
    let current=true;
    request<Facade>(path).then(value=>{if(current){setPhoto(value);setError('');}})
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
      const data=new FormData();
      data.append('revision',photo.revision);
      data.append('photo',{uri:result.assets[0].uri,name:'fachada.jpg',type:result.assets[0].mimeType || 'image/jpeg'} as unknown as Blob);
      await request(path,{method:'PUT',body:data});
      setPhoto({...photo,image:result.assets[0].uri,capture:false,requested:false});
    } catch (e) {setError((e as Error).message);}
    finally {setBusy(false);}
  }
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>Foto da casa</Text>
    {photo?.image && <Image source={{uri:photo.image}} accessibilityLabel="Fachada do endereço de entrega" resizeMode="contain" style={styles.image}/>}
    {photo && !photo.image && <Text>{photo.capture?'Fotografe a fachada para ajudar nas próximas entregas.':'Nenhuma foto cadastrada para este endereço.'}</Text>}
    {!photo && !error && <Text>Buscando foto…</Text>}
    {photo?.capture && <Pressable accessibilityRole="button" disabled={busy} onPress={capture} style={styles.button}>
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
