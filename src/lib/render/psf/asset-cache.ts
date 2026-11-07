// Byte-accounted LRU. Active render assets can be pinned while yielding to messages.
export class AssetCache<T> {
  private items=new Map<string,{value:T;bytes:number}>();
  private used=0;
  readonly pinned=new Set<string>();
  readonly budget:number;
  constructor(budget:number) {this.budget=budget;}
  get(key:string):T|undefined {
    const item=this.items.get(key);
    if(item){this.items.delete(key);this.items.set(key,item);}
    return item?.value;
  }
  set(key:string,value:T,bytes:number):void {
    if(bytes>this.budget||bytes<0)throw new Error('Asset exceeds memory budget');
    const old=this.items.get(key);
    const protectedBytes=[...this.items].reduce((n,[k,v])=>n+(k!==key&&this.pinned.has(k)?v.bytes:0),0);
    if(protectedBytes+bytes>this.budget)throw new Error('Active assets exceed memory budget');
    if(old){this.items.delete(key);this.used-=old.bytes;}
    while(this.used+bytes>this.budget){
      const oldest=[...this.items.keys()].find(k=>!this.pinned.has(k))!;
      this.used-=this.items.get(oldest)!.bytes;this.items.delete(oldest);
    }
    this.items.set(key,{value,bytes});this.used+=bytes;
  }
  clear():void {this.items.clear();this.used=0;this.pinned.clear();}
  info():{keys:string[];bytes:number} {return {keys:[...this.items.keys()],bytes:this.used};}
}
