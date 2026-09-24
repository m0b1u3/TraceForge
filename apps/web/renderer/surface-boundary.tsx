import React from "react";

/** A failed read-only surface must not take the composer or other pages down. */
export class SurfaceBoundary extends React.Component<{children:React.ReactNode;label:string},{failed:boolean;revision:number}>{
  state={failed:false,revision:0};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<section className="surface-error" role="alert">
    <h3>{this.props.label}暂时无法显示</h3><p>已保存的数据不会删除，也不会重新执行任务。可以重新读取此区域。</p>
    <button onClick={()=>this.setState(state=>({failed:false,revision:state.revision+1}))}>重新读取{this.props.label}</button>
  </section>:<React.Fragment key={this.state.revision}>{this.props.children}</React.Fragment>;}
}
