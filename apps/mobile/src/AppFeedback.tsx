import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AlertButton } from 'react-native';
import { brand } from './brand';

type Message = {title:string;message?:string;buttons:AlertButton[]};
let listener:((message:Message)=>void)|undefined;
const pending:Message[]=[];
export const AppAlert={
  alert(title:string,message?:string,buttons:AlertButton[]=[{text:'Entendido'}]) {
    const next={title,message,buttons};
    if(listener)listener(next);else pending.push(next);
  },
};
export function AppFeedback() {
  const [queue,setQueue]=useState<Message[]>([]);
  useEffect(()=>{
    listener=message=>setQueue(current=>[...current,message]);
    setQueue(pending.splice(0));
    return ()=>{listener=undefined;};
  },[]);
  const current=queue[0];
  function choose(button:AlertButton) {
    setQueue(items=>items.slice(1));
    button.onPress?.();
  }
  return <Modal visible={!!current} transparent animationType="fade"
    onRequestClose={()=>{const cancel=current?.buttons.find(b=>b.style==='cancel');if(cancel)choose(cancel);else if(current?.buttons.length===1)choose(current.buttons[0]);}}>
    <View style={s.backdrop}><View style={s.card} accessibilityViewIsModal>
      <ScrollView><Text style={s.title}>{current?.title}</Text><Text style={s.message}>{current?.message}</Text>
        <View style={s.actions}>{current?.buttons.map((button,index)=><Pressable key={index} accessibilityRole="button"
          onPress={()=>choose(button)} style={[s.button,button.style==='destructive'&&s.danger,button.style==='cancel'&&s.cancel]}>
          <Text style={{color:button.style==='cancel'?brand.petroleum:'white',fontWeight:'600'}}>{button.text}</Text>
        </Pressable>)}</View>
      </ScrollView>
    </View></View>
  </Modal>;
}
const s=StyleSheet.create({
  backdrop:{flex:1,backgroundColor:'#0008',justifyContent:'center',padding:24},
  card:{backgroundColor:'white',borderRadius:18,padding:20,maxHeight:'85%'},
  title:{fontSize:20,fontWeight:'600',color:brand.text},message:{fontSize:16,color:brand.text,marginVertical:16},
  actions:{gap:10},button:{minHeight:48,padding:14,borderRadius:10,backgroundColor:brand.petroleum,alignItems:'center'},
  danger:{backgroundColor:brand.danger},cancel:{backgroundColor:brand.petroleumLight},
});
