// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { InvoiceRegistry } from "../contracts/InvoiceRegistry.sol";

contract DeployInvoiceRegistry is Script {
  function run() external returns (InvoiceRegistry deployed) {
    uint256 pk = vm.envUint("MERCHANT_PK");
    vm.startBroadcast(pk);
    deployed = new InvoiceRegistry();
    vm.stopBroadcast();
  }
}
